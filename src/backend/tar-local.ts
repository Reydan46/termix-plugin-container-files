import type { Readable } from "node:stream";
import tar from "tar-stream";
import { HttpError } from "./helpers.js";
import type { Owner } from "./tar.js";

export interface WalkFile {
  localPath: string;
  /** "/"-separated and includes the dropped root's own name. */
  relativePath: string;
  size: number;
}

export interface WalkLike {
  files: WalkFile[];
  emptyDirs: string[];
}

export interface OpenedFile {
  stream: NodeJS.ReadableStream;
  size: number;
}

const slashes = (value: string) => value.replace(/\\/g, "/");

/** Last segment of a local path, with either separator. */
export function localBaseName(path: string): string {
  const parts = slashes(path).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** Archive name of an empty directory the walk reported (absolute or relative). */
function emptyDirName(dir: string, roots: string[]): string | null {
  const d = slashes(dir).replace(/\/+$/, "");
  for (const root of roots) {
    const r = slashes(root).replace(/\/+$/, "");
    if (d === r) return localBaseName(r);
    if (d.startsWith(`${r}/`)) {
      return `${localBaseName(r)}/${d.slice(r.length + 1)}`;
    }
  }
  return /^([a-zA-Z]:)?\//.test(d) ? null : d.replace(/^\.?\/+/, "");
}

/**
 * Packs the files of a local walk into a tar stream. Directories are written
 * explicitly (empty ones and every parent) so ownership is set on all of them.
 * Files are read one at a time; a destroyed pack (cancel) stops the loop and
 * closes the file being read.
 */
export function packWalk(
  walk: WalkLike,
  roots: string[],
  openRead: (path: string) => Promise<OpenedFile>,
  options: {
    owner?: Owner;
    signal?: AbortSignal;
    onBytes?: (n: number) => void;
  } = {},
): tar.Pack {
  const pack = tar.pack();
  const { owner, signal } = options;
  let current: NodeJS.ReadableStream | null = null;
  let stopped = false;

  const stop = (error?: Error) => {
    if (stopped) return;
    stopped = true;
    (current as unknown as Readable | null)?.destroy?.();
    pack.destroy(error);
  };
  const onAbort = () => stop(new HttpError(499, "Cancelled", "CANCELLED"));
  signal?.addEventListener("abort", onAbort, { once: true });
  pack.once("close", () => signal?.removeEventListener("abort", onAbort));

  const addDir = (name: string) =>
    new Promise<void>((resolve, reject) => {
      pack.entry(
        {
          name: `${name}/`,
          type: "directory",
          mode: 0o755,
          mtime: new Date(),
          uid: owner?.uid,
          gid: owner?.gid,
        },
        (error) => (error ? reject(error) : resolve()),
      );
    });

  const addFile = async (name: string, localPath: string) => {
    const opened = await openRead(localPath);
    current = opened.stream;
    if (stopped) {
      (opened.stream as unknown as Readable).destroy?.();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const entry = pack.entry(
        {
          name,
          type: "file",
          size: opened.size,
          mode: 0o644,
          mtime: new Date(),
          uid: owner?.uid,
          gid: owner?.gid,
        },
        (error) => (error ? reject(error) : resolve()),
      );
      opened.stream.on("data", (chunk: Buffer | string) =>
        options.onBytes?.(chunk.length),
      );
      // A destroyed pack errors its open entry; that is the cancel path.
      (entry as unknown as NodeJS.EventEmitter).on("error", reject);
      opened.stream.on("error", reject);
      opened.stream.pipe(entry as unknown as NodeJS.WritableStream);
    });
    current = null;
  };

  void (async () => {
    const dirs = new Set<string>();
    const dirNames: string[] = [];
    const need = (dir: string) => {
      const parts = dir.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        const sub = parts.slice(0, i).join("/");
        if (!dirs.has(sub)) {
          dirs.add(sub);
          dirNames.push(sub);
        }
      }
    };
    const files = walk.files.map((f) => ({
      ...f,
      name: slashes(f.relativePath).replace(/^\/+/, ""),
    }));
    for (const f of files) need(f.name.split("/").slice(0, -1).join("/"));
    for (const d of walk.emptyDirs) {
      const name = emptyDirName(d, roots);
      if (name) need(name);
    }
    dirNames.sort();
    try {
      for (const d of dirNames) {
        if (stopped) return;
        await addDir(d);
      }
      for (const f of files) {
        if (stopped) return;
        await addFile(f.name, f.localPath);
      }
      if (!stopped) pack.finalize();
    } catch (error) {
      stop(error as Error);
    }
  })();
  return pack;
}

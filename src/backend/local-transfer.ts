import { posix, win32 } from "node:path";
import type { Readable, Writable } from "node:stream";
import tar from "tar-stream";
import type { PluginDesktopLocal } from "@termix-ssh/plugin-sdk/backend";
import { duBytes, ownRename } from "./c2c.js";
import { openCpSource } from "./channel-stream.js";
import { cpUpload } from "./cp-io.js";
import type { ListTarget } from "./fs-list.js";
import { HttpError, partName } from "./helpers.js";
import { checkEntryName, sanitizeTar } from "./tar.js";
import { localBaseName, packWalk } from "./tar-local.js";
import {
  directoryOwner,
  moveIntoPlace,
  removeTemp,
  type Transfer,
} from "./transfers.js";

type LocalFs = PluginDesktopLocal["fs"];

export interface LocalUploadParams {
  /** Container directory the items land in. */
  dir: string;
  localPaths: string[];
  renames?: Record<string, string>;
  skip?: string[];
}

/**
 * Uploads local files and folders into a container directory as one tar
 * stream (no per-file round trips). A lone file goes through a temporary name
 * and `mv`, so a cancelled upload never leaves a half-written file.
 */
export async function uploadFromLocal(
  t: ListTarget,
  fs: LocalFs,
  transfer: Transfer,
  params: LocalUploadParams,
): Promise<{ files: number; dirs: number }> {
  const { signal } = transfer.controller;
  const skip = new Set(params.skip ?? []);
  const roots = params.localPaths.filter((p) => !skip.has(localBaseName(p)));
  if (roots.length === 0) return { files: 0, dirs: 0 };

  const walk = await fs.walk(roots);
  signal.throwIfAborted();
  transfer.total = walk.totalBytes;
  const owner = await directoryOwner(t, params.dir, signal);
  const rename = ownRename(params.renames);

  const single =
    t.capabilities.exec &&
    walk.files.length === 1 &&
    walk.emptyDirs.length === 0 &&
    !walk.files[0].relativePath.replace(/\\/g, "/").includes("/")
      ? walk.files[0].relativePath
      : null;
  const finalName = single ? rename(single) : "";
  const tempName = single ? partName(transfer.id, finalName) : "";

  const pack = packWalk(walk, roots, (p) => fs.openRead(p), {
    owner,
    signal,
    onBytes: (n) => (transfer.bytes += n),
  });
  try {
    await cpUpload(
      t,
      params.dir,
      sanitizeTar(pack as unknown as Readable, {
        owner,
        rename: single ? () => tempName : rename,
      }),
      signal,
    );
    if (single) {
      await moveIntoPlace(
        t,
        posix.join(params.dir, tempName),
        posix.join(params.dir, finalName),
        true,
      );
    }
  } catch (error) {
    pack.destroy();
    if (single) await removeTemp(t, posix.join(params.dir, tempName));
    throw error;
  }
  return {
    files: walk.files.length,
    dirs: walk.emptyDirs.length,
  };
}

export interface LocalDownloadParams {
  paths: string[];
  localDir: string;
  renames?: Record<string, string>;
  skip?: string[];
}

export interface LocalDownloadResult {
  files: number;
  dirs: number;
  /** Entries left out: links, device nodes, names the local disk refuses. */
  skipped: string[];
  /** Why the first skipped entry failed on the local disk, when it did. */
  firstError?: string;
  /** Bytes of file content written to the local disk. */
  bytesWritten: number;
}

const WIN_ABSOLUTE = /^([A-Za-z]:([\\/]|$)|\\\\)/;
/** `//host/share` is UNC only on Windows; elsewhere it is a POSIX path. */
const WIN_UNC_SLASH = /^\/\/[^/]/;

/**
 * The local destination folder as an absolute path in its own flavour.
 * Windows paths (`C:\x`, `C:/x`, UNC, and the `/C:/x` form some file lists
 * produce) get the win32 rules whatever OS runs the backend; anything else
 * must be a POSIX absolute path. Relative paths are refused: they would land
 * wherever the backend process happens to run.
 */
export function normalizeLocalDir(dir: string): {
  path: string;
  api: typeof win32 | typeof posix;
} {
  const lead = /^\/([A-Za-z]:([\\/]|$))/.exec(dir);
  const raw = lead ? dir.slice(1) : dir;
  const windows =
    WIN_ABSOLUTE.test(raw) ||
    (process.platform === "win32" && WIN_UNC_SLASH.test(raw));
  const api = windows ? win32 : posix;
  if (!api.isAbsolute(raw)) {
    throw new HttpError(
      400,
      `The destination must be an absolute local path: ${dir}`,
      "BAD_REQUEST",
    );
  }
  return { path: api.resolve(raw), api };
}

/** Local path of an archive entry, never outside `root`. */
export function localTarget(root: string, rel: string): string {
  const { path: base, api } = normalizeLocalDir(root);
  const full = api.resolve(base, ...rel.split("/"));
  if (
    full !== base &&
    !full.startsWith(base.endsWith(api.sep) ? base : base + api.sep)
  ) {
    throw new HttpError(400, `Unsafe archive entry: ${rel}`, "UNSAFE_ARCHIVE");
  }
  return full;
}

/**
 * Downloads container paths into a local folder by unpacking the `cp` tar
 * entry by entry. Files are written next to their final name and published
 * when complete; a cancel or error aborts the partial file.
 */
export async function downloadToLocal(
  t: ListTarget,
  fs: LocalFs,
  transfer: Transfer,
  params: LocalDownloadParams,
): Promise<LocalDownloadResult> {
  const { signal } = transfer.controller;
  const skip = new Set(params.skip ?? []);
  const paths = params.paths.filter((p) => !skip.has(posix.basename(p)));
  transfer.total = await duBytes(t, paths, signal);
  const rename = ownRename(params.renames);
  const result: LocalDownloadResult = {
    files: 0,
    dirs: 0,
    skipped: [],
    bytesWritten: 0,
  };
  const ensured = new Set<string>();
  const root = normalizeLocalDir(params.localDir);

  const ensureDir = async (dir: string) => {
    if (ensured.has(dir)) return;
    // The chosen folder itself is not "inside" itself: the desktop's
    // containment check refuses it ("would be written outside the selected
    // folder"), so it is ensured without a root. Everything below it keeps the
    // check.
    if (dir === root.path) await fs.ensureDir(dir);
    else await fs.ensureDir(dir, root.path);
    ensured.add(dir);
  };

  for (const path of paths) {
    if (path === "/") throw new HttpError(400, "Cannot copy the root");
    const source = await openCpSource(
      t,
      path,
      (n) => (transfer.bytes += n),
      signal,
    );
    try {
      await unpack(source.stream, signal, async (header, body) => {
        const name = checkEntryName(header.name).replace(/\/+$/, "");
        const [top, ...rest] = name.split("/");
        const rel = [rename(top), ...rest].join("/");
        if (header.type !== "file" && header.type !== "directory") {
          result.skipped.push(name);
          body.resume();
          return;
        }
        let dest: string;
        try {
          dest = localTarget(root.path, rel);
        } catch (error) {
          body.resume();
          throw error;
        }
        try {
          if (header.type === "directory") {
            await ensureDir(dest);
            result.dirs++;
            body.resume();
            return;
          }
          await ensureDir(root.api.dirname(dest));
          const download = await fs.openDownload({
            rootPath: root.path,
            destPath: dest,
            transferId: transfer.id,
            overwrite: true,
          });
          try {
            let received = 0;
            body.on("data", (chunk: Buffer) => (received += chunk.length));
            await new Promise<void>((done, fail) => {
              const onAbort = () =>
                fail(new HttpError(499, "Cancelled", "CANCELLED"));
              signal.addEventListener("abort", onAbort, { once: true });
              download.stream.once("finish", () => {
                signal.removeEventListener("abort", onAbort);
                done();
              });
              download.stream.once("error", fail);
              body.once("error", fail);
              body.pipe(download.stream);
            });
            // Windows cannot rename a file that is still open: wait for close.
            await streamClosed(download.stream);
            if (received !== (header.size ?? 0)) {
              throw new Error(
                `Incomplete file ${name}: ${received} of ${header.size ?? 0} bytes`,
              );
            }
            await download.publish({ overwrite: true });
            result.files++;
            result.bytesWritten += received;
          } catch (error) {
            (download.stream as unknown as Writable).destroy?.();
            await download.abort().catch(() => {});
            throw error;
          }
        } catch (error) {
          if (signal.aborted || error instanceof HttpError) throw error;
          // The local disk refused this one (name, permissions): report it.
          result.skipped.push(name);
          result.firstError ??=
            error instanceof Error ? error.message : String(error);
          body.resume();
        }
      });
    } finally {
      source.close();
    }
  }
  // Never report success when nothing reached the disk.
  if (paths.length > 0 && result.files + result.dirs === 0) {
    throw new HttpError(
      500,
      result.firstError
        ? `Nothing was written to ${root.path}: ${result.firstError}`
        : `Nothing was written to ${root.path}`,
      "NOTHING_WRITTEN",
      { skipped: result.skipped },
    );
  }
  return result;
}

/** Resolves once a finished write stream released its file (or cannot say). */
async function streamClosed(stream: NodeJS.WritableStream): Promise<void> {
  const s = stream as unknown as {
    closed?: boolean;
    destroyed?: boolean;
    once: (event: "close", cb: () => void) => void;
  };
  if (s.closed !== false || s.destroyed) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(done, 3000);
    s.once("close", () => {
      clearTimeout(timer);
      done();
    });
  });
}

/** Runs `onEntry` for every entry of a tar stream, one at a time. */
function unpack(
  input: Readable,
  signal: AbortSignal,
  onEntry: (header: tar.Header, body: Readable) => Promise<void>,
): Promise<void> {
  return new Promise<void>((resolveAll, reject) => {
    const extract = tar.extract();
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) {
        input.unpipe(extract);
        extract.destroy();
        reject(error);
      } else {
        resolveAll();
      }
    };
    const onAbort = () => settle(new HttpError(499, "Cancelled", "CANCELLED"));
    signal.addEventListener("abort", onAbort, { once: true });

    extract.on("entry", (header, body, next) => {
      const entry = body as unknown as Readable;
      onEntry(header, entry).then(
        () => {
          if (entry.readableEnded || entry.destroyed) next();
          else entry.once("end", () => next());
          // An entry the callback did not drain would stall the archive.
          entry.resume();
        },
        (error: Error) => {
          entry.resume();
          settle(error);
        },
      );
    });
    extract.on("finish", () => settle());
    extract.on("error", (e) => settle(e));
    input.on("error", (e) => settle(e));
    input.pipe(extract);
  });
}

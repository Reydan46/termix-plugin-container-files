import { posix } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import tar from "tar-stream";
import { HttpError } from "./helpers.js";
import { engineCommand, type ContainerRuntime } from "./shell-quote.js";

export interface Owner {
  uid: number;
  gid: number;
}

/** `cp` from the container to stdout as a tar stream. */
export function cpFromCommand(
  runtime: ContainerRuntime,
  containerId: string,
  path: string,
): string {
  return engineCommand(runtime, [
    "cp",
    // docker follows the link with -L; podman always does for a given path.
    ...(runtime === "docker" ? ["-L"] : []),
    `${containerId}:${path}`,
    "-",
  ]);
}

/** `cp` a tar stream on stdin into a directory of the container. */
export function cpToCommand(
  runtime: ContainerRuntime,
  containerId: string,
  dir: string,
): string {
  return engineCommand(runtime, [
    "cp",
    // -a makes docker honor the uid/gid in the archive.
    ...(runtime === "docker" ? ["-a"] : []),
    "-",
    `${containerId}:${dir}`,
  ]);
}

/** Validates an entry name and returns it without leading `./`. */
export function checkEntryName(name: string): string {
  if (name.includes("\0")) throw new HttpError(400, "Invalid archive entry");
  const clean = posix.normalize(name.replace(/^(\.\/)+/, ""));
  if (
    clean.startsWith("/") ||
    clean === ".." ||
    clean.startsWith("../") ||
    clean === "."
  ) {
    throw new HttpError(400, `Unsafe archive entry: ${name}`, "UNSAFE_ARCHIVE");
  }
  return clean;
}

function checkHeader(header: tar.Header, allowHardlinks = false): void {
  const name = checkEntryName(header.name);
  switch (header.type) {
    case "file":
    case "directory":
      return;
    case "link": {
      // `docker cp` writes a second name of one inode as a hard link whose
      // target is a path inside the same archive.
      if (!allowHardlinks) break;
      checkEntryName(header.linkname ?? "");
      return;
    }
    case "symlink": {
      const link = header.linkname ?? "";
      if (link.startsWith("/") || link.includes("\0")) {
        throw new HttpError(400, `Unsafe symlink: ${name}`, "UNSAFE_ARCHIVE");
      }
      const resolved = posix.normalize(posix.join(posix.dirname(name), link));
      if (resolved === ".." || resolved.startsWith("../")) {
        throw new HttpError(400, `Unsafe symlink: ${name}`, "UNSAFE_ARCHIVE");
      }
      return;
    }
  }
  throw new HttpError(
    400,
    `Unsupported archive entry type for ${name}`,
    "UNSAFE_ARCHIVE",
  );
}

/**
 * Re-packs a tar stream, rejecting traversal, absolute names, escaping
 * symlinks and device nodes. With `owner`, every entry gets that uid/gid.
 */
export function sanitizeTar(
  input: Readable,
  options: {
    owner?: Owner;
    /** Maps the first path segment of every entry (keep both / temp name). */
    rename?: (topLevel: string) => string;
    /** Keep hard links (target inside the archive); container copies need it. */
    allowHardlinks?: boolean;
  } = {},
): tar.Pack {
  const extract = tar.extract();
  const pack = tar.pack();
  const fail = (error: Error) => {
    (input as { unpipe?: (d: unknown) => void }).unpipe?.(extract);
    input.destroy();
    extract.destroy();
    pack.destroy(error);
  };

  extract.on("entry", (header, stream, next) => {
    try {
      checkHeader(header, options.allowHardlinks);
    } catch (error) {
      stream.resume();
      fail(error as Error);
      return;
    }
    let name = checkEntryName(header.name).replace(/\/+$/, "");
    if (options.rename) {
      const [top, ...rest] = name.split("/");
      const renamed = options.rename(top);
      if (!renamed || renamed.includes("/") || renamed === "..") {
        stream.resume();
        fail(new HttpError(400, "Invalid target name", "UNSAFE_ARCHIVE"));
        return;
      }
      name = [renamed, ...rest].join("/");
    }
    const out: tar.Header = {
      ...header,
      name: name + (header.type === "directory" ? "/" : ""),
    };
    if (header.type === "link") {
      // The target is an archive path, so its first segment is renamed too.
      const [top, ...rest] = checkEntryName(header.linkname ?? "").split("/");
      const renamed = options.rename ? options.rename(top) : top;
      if (!renamed || renamed.includes("/") || renamed === "..") {
        stream.resume();
        fail(new HttpError(400, "Invalid target name", "UNSAFE_ARCHIVE"));
        return;
      }
      out.linkname = [renamed, ...rest].join("/");
    }
    if (options.owner) {
      out.uid = options.owner.uid;
      out.gid = options.owner.gid;
      delete out.uname;
      delete out.gname;
    }
    const sink = pack.entry(out, next);
    // A destroyed output (cancel) closes the open entry; that is not new news.
    (sink as unknown as NodeJS.EventEmitter).on("error", () => {});
    stream.on("error", () => {});
    stream.pipe(sink);
  });
  extract.on("finish", () => pack.finalize());
  extract.on("error", fail);
  input.on("error", fail);
  input.pipe(extract);
  return pack;
}

/** A tar stream holding one file whose body is `body` (size must be exact). */
export function packSingleFile(
  name: string,
  size: number,
  body: Readable,
  attrs: { mode?: number; mtime?: Date; owner?: Owner } = {},
): tar.Pack {
  const pack = tar.pack();
  const entry = pack.entry(
    {
      name,
      size,
      type: "file",
      mode: attrs.mode ?? 0o644,
      mtime: attrs.mtime ?? new Date(),
      uid: attrs.owner?.uid,
      gid: attrs.owner?.gid,
    },
    (error) => {
      if (error) pack.destroy(error);
      else pack.finalize();
    },
  );
  body.on("error", (e) => pack.destroy(e));
  body.pipe(entry);
  return pack;
}

export function packBuffer(
  name: string,
  data: Buffer,
  attrs: { mode?: number; owner?: Owner } = {},
): tar.Pack {
  const body = new PassThrough();
  body.end(data);
  return packSingleFile(name, data.length, body, attrs);
}

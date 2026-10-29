import type { Readable } from "node:stream";
import tar from "tar-stream";
import { channelDone, openChannelAbortable } from "./exec.js";
import { HttpError } from "./helpers.js";
import type { ListTarget } from "./fs-list.js";
import { cpFromCommand, cpToCommand } from "./tar.js";

/** Maps `docker cp` stderr to an HTTP error. */
export function cpError(stderr: string): HttpError {
  const text = stderr.trim();
  if (
    /could not find|no such (file|container|directory)|not found/i.test(text)
  ) {
    return new HttpError(404, "Not found", "NOT_FOUND");
  }
  if (/permission denied|operation not permitted/i.test(text)) {
    return new HttpError(403, "Permission denied", "PERMISSION_DENIED");
  }
  if (/not a directory/i.test(text)) {
    return new HttpError(400, "Not a directory", "NOT_A_DIRECTORY");
  }
  if (/no space left/i.test(text)) {
    return new HttpError(507, "No space left on device", "NO_SPACE");
  }
  if (/read-only file system/i.test(text)) {
    return new HttpError(403, "Read-only file system", "READ_ONLY");
  }
  return new HttpError(500, text || "Copy failed", "CP_FAILED");
}

export interface CpFile {
  data: Buffer;
  size: number;
  mtime: number;
  mode: number;
}

/** Reads one regular file into memory through `cp`, working without a shell. */
export async function cpReadFile(
  t: ListTarget,
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<CpFile> {
  signal?.throwIfAborted();
  const channel = await openChannelAbortable(
    t.client,
    cpFromCommand(t.runtime, t.containerId, path),
    signal,
  );
  const stderr = { text: "" };
  const done = channelDone(channel, stderr);
  done.catch(() => {});

  return new Promise<CpFile>((resolve, reject) => {
    const extract = tar.extract();
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      channel.destroy();
      fn();
    };
    const onAbort = () =>
      settle(() => reject(new HttpError(499, "Cancelled", "CANCELLED")));
    signal?.addEventListener("abort", onAbort, { once: true });

    let first = true;
    extract.on("entry", (header, stream, next) => {
      if (!first) {
        stream.resume();
        stream.on("end", next);
        return;
      }
      first = false;
      if (header.type !== "file") {
        stream.resume();
        settle(() =>
          reject(new HttpError(400, "Not a regular file", "NOT_A_FILE")),
        );
        return;
      }
      if ((header.size ?? 0) > maxBytes) {
        stream.resume();
        settle(() => reject(new HttpError(413, "File too large", "TOO_LARGE")));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () =>
        settle(() =>
          resolve({
            data: Buffer.concat(chunks),
            size: header.size ?? 0,
            mtime: header.mtime ? Math.floor(header.mtime.getTime() / 1000) : 0,
            mode: (header.mode ?? 0) & 0o7777,
          }),
        ),
      );
    });
    extract.on("error", (e) => settle(() => reject(e)));
    channel.on("data", (d: Buffer) => {
      if (!extract.write(d)) {
        channel.pause();
        extract.once("drain", () => channel.resume());
      }
    });
    channel.once("close", () => {
      if (settled) return;
      done.then(
        () => extract.end(() => {}),
        () => settle(() => reject(cpError(stderr.text))),
      );
    });
  });
}

/**
 * Streams a tar into `dir` of the container. Resolves when `cp` exits cleanly;
 * a broken or aborted source stream fails the transfer.
 */
export async function cpUpload(
  t: ListTarget,
  dir: string,
  source: Readable | tar.Pack,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const archive = source as Readable;
  const channel = await openChannelAbortable(
    t.client,
    cpToCommand(t.runtime, t.containerId, dir),
    signal,
    true,
  );
  const stderr = { text: "" };
  const done = channelDone(channel, stderr);
  const onAbort = () => {
    archive.destroy();
    channel.destroy();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  // A cancel between the channel opening and this line fired no event.
  if (signal?.aborted) onAbort();
  let sourceError: Error | undefined;
  archive.on("error", (e) => {
    sourceError = e;
    channel.destroy();
  });
  // ssh2 closes the channel only after stdout ends, so it must be drained.
  channel.resume();
  archive.pipe(channel);
  try {
    await done;
  } catch {
    if (sourceError) throw sourceError;
    if (signal?.aborted) throw new HttpError(499, "Cancelled", "CANCELLED");
    throw cpError(stderr.text);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

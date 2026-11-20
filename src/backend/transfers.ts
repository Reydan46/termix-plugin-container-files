import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { Transform, type Readable } from "node:stream";
import type { Request, Response } from "express";
import tar from "tar-stream";
import { cpError, cpUpload } from "./cp-io.js";
import {
  channelDone,
  killChannel,
  openChannel,
  openChannelAbortable,
  runCommand,
} from "./exec.js";
import { EXIT_EXISTS, errorFromResult } from "./fs-ops.js";
import type { ListTarget } from "./fs-list.js";
import { HttpError, partName } from "./helpers.js";
import { execScriptCommand, safeName, safeRelative } from "./shell-quote.js";
import {
  cpFromCommand,
  packSingleFile,
  sanitizeTar,
  type Owner,
} from "./tar.js";

export type TransferState = "running" | "done" | "error" | "cancelled";

export interface Transfer {
  id: string;
  userId: string;
  direction: "upload" | "download" | "local-up" | "local-down" | "c2c";
  /** Total bytes when known (0 otherwise). */
  total: number;
  bytes: number;
  state: TransferState;
  error?: string;
  startedAt: number;
  controller: AbortController;
  /** Random part of the temporary file name, so a replaced transfer keeps its own. */
  part: string;
}

const MAX_TRACKED = 500;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export class TransferRegistry {
  private transfers = new Map<string, Transfer>();

  start(
    id: unknown,
    userId: string,
    direction: Transfer["direction"],
    total: number,
  ): Transfer {
    if (typeof id !== "string" || !ID_RE.test(id)) {
      throw new HttpError(400, "Invalid transfer id");
    }
    const existing = this.transfers.get(id);
    if (existing && existing.state === "running") {
      // Ids are random, so the same user sending one again is a retry of a
      // request the browser or a proxy repeated while the first is still
      // open. The first is stale: stop it and let the retry take over.
      if (existing.userId !== userId) {
        throw new HttpError(409, "Transfer id already in use");
      }
      existing.state = "cancelled";
      existing.controller.abort();
    }
    if (this.transfers.size >= MAX_TRACKED) {
      for (const [key, value] of this.transfers) {
        if (value.state !== "running") this.transfers.delete(key);
        if (this.transfers.size < MAX_TRACKED / 2) break;
      }
    }
    const transfer: Transfer = {
      id,
      userId,
      direction,
      total,
      bytes: 0,
      state: "running",
      startedAt: Date.now(),
      controller: new AbortController(),
      part: randomBytes(4).toString("hex"),
    };
    this.transfers.set(id, transfer);
    return transfer;
  }

  get(id: string, userId: string): Transfer | undefined {
    const transfer = this.transfers.get(id);
    return transfer && transfer.userId === userId ? transfer : undefined;
  }

  cancel(id: string, userId: string): boolean {
    const transfer = this.get(id, userId);
    if (!transfer || transfer.state !== "running") return false;
    transfer.state = "cancelled";
    transfer.controller.abort();
    return true;
  }

  finish(transfer: Transfer, error?: unknown): void {
    if (transfer.state === "cancelled") return;
    if (error) {
      transfer.state = "error";
      transfer.error = error instanceof Error ? error.message : String(error);
    } else {
      transfer.state = "done";
    }
  }

  abortAll(): void {
    for (const t of this.transfers.values()) {
      if (t.state === "running") t.controller.abort();
    }
  }
}

export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface DownloadParams {
  path: string;
  kind: "file" | "directory";
}

/**
 * Streams a file or a whole directory out of the container. A file is cut out
 * of the `cp` tar (exact Content-Length); a directory goes out as a .tar.
 */
export async function download(
  t: ListTarget,
  transfer: Transfer,
  res: Response,
  params: DownloadParams,
): Promise<void> {
  const { signal } = transfer.controller;
  signal.throwIfAborted();
  const base = params.path === "/" ? "root" : posix.basename(params.path);
  const channel = await openChannelAbortable(
    t.client,
    cpFromCommand(t.runtime, t.containerId, params.path),
    signal,
  );
  const stderr = { text: "" };
  const done = channelDone(channel, stderr);
  done.catch(() => {}); // the stream's own error path reports it; this only avoids an unhandled rejection
  const onAbort = () => {
    killChannel(channel);
    if (!res.writableEnded) res.destroy();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  res.on("close", () => {
    if (!res.writableFinished) transfer.controller.abort();
  });

  try {
    if (params.kind === "directory") {
      await streamDirectory(channel, done, stderr, transfer, res, base);
    } else {
      await streamFile(channel, done, stderr, transfer, res);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    killChannel(channel);
  }
}

type Channel = Awaited<ReturnType<typeof openChannel>>;

function streamDirectory(
  channel: Channel,
  done: Promise<void>,
  stderr: { text: string },
  transfer: Transfer,
  res: Response,
  base: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let started = false;
    channel.on("data", (chunk: Buffer) => {
      if (!started) {
        started = true;
        res.setHeader("Content-Type", "application/x-tar");
        res.setHeader("Content-Disposition", contentDisposition(`${base}.tar`));
      }
      transfer.bytes += chunk.length;
      if (!res.write(chunk)) {
        channel.pause();
        res.once("drain", () => channel.resume());
      }
    });
    channel.once("close", () => {
      done.then(
        () => {
          res.end();
          resolve();
        },
        () => {
          const error = cpError(stderr.text);
          if (started) {
            // Headers are out: break the connection so the client sees a failure.
            res.destroy();
            reject(error);
          } else {
            reject(error);
          }
        },
      );
    });
    channel.once("error", reject);
  });
}

function streamFile(
  channel: Channel,
  done: Promise<void>,
  stderr: { text: string },
  transfer: Transfer,
  res: Response,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    let gotEntry = false;
    let finished = false;

    extract.on("entry", (header, stream, next) => {
      if (gotEntry) {
        stream.resume();
        stream.on("end", next);
        return;
      }
      gotEntry = true;
      if (header.type !== "file") {
        stream.resume();
        reject(new HttpError(400, "Not a regular file", "NOT_A_FILE"));
        return;
      }
      const size = header.size ?? 0;
      transfer.total = size;
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", String(size));
      res.setHeader(
        "Content-Disposition",
        contentDisposition(posix.basename(header.name)),
      );
      stream.on("data", (chunk: Buffer) => {
        transfer.bytes += chunk.length;
        if (!res.write(chunk)) {
          stream.pause();
          res.once("drain", () => stream.resume());
        }
      });
      stream.on("end", () => {
        finished = transfer.bytes === size;
        if (!finished) {
          res.destroy();
          reject(new HttpError(502, "Truncated file", "TRUNCATED"));
          return;
        }
        res.end();
        resolve();
      });
      stream.on("error", reject);
    });
    extract.on("error", reject);

    channel.on("data", (chunk: Buffer) => {
      if (finished) return;
      if (!extract.write(chunk)) {
        channel.pause();
        extract.once("drain", () => channel.resume());
      }
    });
    channel.once("close", () => {
      if (finished) return;
      done.then(
        () => {
          if (!gotEntry) reject(new HttpError(404, "Not found", "NOT_FOUND"));
          else extract.end(() => {});
        },
        () => reject(cpError(stderr.text)),
      );
    });
    channel.once("error", reject);
  });
}

export interface UploadParams {
  /** Destination directory. */
  dir: string;
  format: "file" | "tar";
  /** For format "file": a file name, or a relative path inside `dir`. */
  name?: string;
  rel?: string;
  overwrite: boolean;
  mode?: number;
  mtime?: Date;
  /** Byte count to use when the request carries no Content-Length. */
  size?: number;
  /** One piece of a file sent in several requests (a proxy limits one body). */
  chunk?: { group: string; part: number; parts: number; abort: boolean };
}

/** Looks up uid/gid of a directory so uploads belong to the same owner. */
export async function directoryOwner(
  t: ListTarget,
  dir: string,
  signal?: AbortSignal,
): Promise<Owner | undefined> {
  if (!t.capabilities.exec) return undefined;
  const result = await runCommand(
    t.client,
    execScriptCommand(
      t.runtime,
      t.containerId,
      `stat -c '%u %g' -- "$1" 2>/dev/null || find "$1" -maxdepth 0 -printf '%U %G'`,
      [dir],
    ),
    { signal, timeoutMs: 15_000 },
  );
  const m = /^(\d+)\s+(\d+)/.exec(result.stdout.toString().trim());
  return m ? { uid: Number(m[1]), gid: Number(m[2]) } : undefined;
}

export async function upload(
  t: ListTarget,
  transfer: Transfer,
  req: Request,
  res: Response,
  params: UploadParams,
): Promise<{ bytes: number }> {
  const { signal } = transfer.controller;
  res.on("close", () => {
    if (!res.writableFinished) transfer.controller.abort();
  });
  if (params.chunk) return uploadChunk(t, transfer, req, params);
  const owner = await directoryOwner(t, params.dir, signal);

  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      transfer.bytes += chunk.length;
      cb(null, chunk);
    },
  });
  req.on("error", (e) => counter.destroy(e));
  // A request whose body was read in full is destroyed afterwards and also
  // says "aborted" (the sandbox never marks it complete); that is no abort.
  req.on("aborted", () => {
    if (!req.readableEnded) transfer.controller.abort();
  });
  req.pipe(counter);

  if (params.format === "tar") {
    await cpUpload(t, params.dir, sanitizeTar(counter, { owner }), signal);
    return { bytes: transfer.bytes };
  }

  const declared = req.headers["content-length"];
  const size = declared === undefined ? params.size : Number(declared);
  if (size === undefined || !Number.isFinite(size) || size < 0) {
    throw new HttpError(411, "Content-Length is required", "LENGTH_REQUIRED");
  }
  transfer.total = size;
  const rel = params.rel ? safeRelative(params.rel) : safeName(params.name);
  const finalPath = posix.join(params.dir, rel);

  // With a shell: check for an existing file first and upload under a
  // temporary name, so a broken transfer never leaves a half-written file.
  const useTemp = t.capabilities.exec;
  if (useTemp && !params.overwrite) {
    const check = await runCommand(
      t.client,
      execScriptCommand(
        t.runtime,
        t.containerId,
        `if [ -e "$1" ] || [ -L "$1" ]; then exit ${EXIT_EXISTS}; fi`,
        [finalPath],
      ),
      { signal, timeoutMs: 15_000 },
    );
    if (check.code !== 0) throw errorFromResult(check);
  }
  const tempRel = useTemp
    ? posix.join(
        posix.dirname(rel),
        partName(transfer.part, posix.basename(rel)),
      )
    : rel;
  const tempPath = posix.join(params.dir, tempRel);

  try {
    await cpUpload(
      t,
      params.dir,
      packSingleFile(tempRel, size, counter as Readable, {
        mode: params.mode,
        mtime: params.mtime,
        owner,
      }),
      signal,
    );
    if (transfer.bytes !== size) {
      throw new HttpError(400, "Upload size mismatch", "SIZE_MISMATCH");
    }
    if (useTemp) await moveIntoPlace(t, tempPath, finalPath, params.overwrite);
  } catch (error) {
    if (useTemp) await removeTemp(t, tempPath);
    throw error;
  }
  return { bytes: size };
}

const MAX_CHUNKS = 4096;

/** Name of piece `part` of a chunked upload, next to the final file. */
function chunkName(rel: string, group: string, part: number): string {
  return posix.join(
    posix.dirname(rel),
    partName(group, `${posix.basename(rel)}.${part}`),
  );
}

/**
 * One piece of a file too big for one request. Pieces are stored next to the
 * target as hidden files; the last one joins them and moves the result into
 * place. Needs a shell in the container.
 */
async function uploadChunk(
  t: ListTarget,
  transfer: Transfer,
  req: Request,
  params: UploadParams,
): Promise<{ bytes: number }> {
  const chunk = params.chunk!;
  const { signal } = transfer.controller;
  const { group, part, parts } = chunk;
  if (
    !ID_RE.test(group) ||
    !Number.isInteger(part) ||
    !Number.isInteger(parts) ||
    parts < 2 ||
    parts > MAX_CHUNKS ||
    part < 0 ||
    part >= parts
  ) {
    throw new HttpError(400, "Invalid chunk", "BAD_CHUNK");
  }
  if (!t.capabilities.exec) {
    throw new HttpError(
      400,
      "A large upload needs a shell in the container",
      "NO_EXEC",
    );
  }
  const rel = params.rel ? safeRelative(params.rel) : safeName(params.name);
  const finalPath = posix.join(params.dir, rel);
  const pieces = (upTo: number) =>
    Array.from({ length: upTo }, (_, k) =>
      posix.join(params.dir, chunkName(rel, group, k)),
    );
  const removePieces = async (upTo: number) => {
    if (upTo <= 0) return;
    await runCommand(
      t.client,
      execScriptCommand(
        t.runtime,
        t.containerId,
        `rm -f -- "$@"`,
        pieces(upTo),
      ),
      { timeoutMs: 30_000 },
    ).catch(() => {}); // best effort: a leftover piece is hidden and harmless
  };
  if (chunk.abort) {
    req.resume();
    await removePieces(part);
    return { bytes: 0 };
  }

  const declared = Number(req.headers["content-length"]);
  if (!Number.isFinite(declared) || declared < 0) {
    throw new HttpError(411, "Content-Length is required", "LENGTH_REQUIRED");
  }
  transfer.total = declared;
  if (part === 0 && !params.overwrite) {
    const check = await runCommand(
      t.client,
      execScriptCommand(
        t.runtime,
        t.containerId,
        `if [ -e "$1" ] || [ -L "$1" ]; then exit ${EXIT_EXISTS}; fi`,
        [finalPath],
      ),
      { signal, timeoutMs: 15_000 },
    );
    if (check.code !== 0) throw errorFromResult(check);
  }
  const owner = await directoryOwner(t, params.dir, signal);
  const counter = new Transform({
    transform(data: Buffer, _enc, cb) {
      transfer.bytes += data.length;
      cb(null, data);
    },
  });
  req.on("error", (e) => counter.destroy(e));
  // A request whose body was read in full is destroyed afterwards and also
  // says "aborted" (the sandbox never marks it complete); that is no abort.
  req.on("aborted", () => {
    if (!req.readableEnded) transfer.controller.abort();
  });
  req.pipe(counter);
  try {
    await cpUpload(
      t,
      params.dir,
      packSingleFile(
        chunkName(rel, group, part),
        declared,
        counter as Readable,
        {
          mode: params.mode,
          mtime: params.mtime,
          owner,
        },
      ),
      signal,
    );
    if (transfer.bytes !== declared) {
      throw new HttpError(400, "Upload size mismatch", "SIZE_MISMATCH");
    }
    if (part === parts - 1) {
      const joined = posix.join(
        params.dir,
        posix.dirname(rel),
        partName(group, posix.basename(rel)),
      );
      const done = await runCommand(
        t.client,
        execScriptCommand(
          t.runtime,
          t.containerId,
          `tmp="$1"; final="$2"; over="$3"; shift 3; : > "$tmp" || exit 1; for p in "$@"; do cat -- "$p" >> "$tmp" || { rm -f -- "$tmp"; exit 1; }; done; rm -f -- "$@"; if [ "$over" = 1 ] && [ -d "$final" ] && [ ! -L "$final" ]; then rm -rf -- "$final"; fi; mv -f -- "$tmp" "$final"`,
          [joined, finalPath, params.overwrite ? "1" : "0", ...pieces(parts)],
        ),
        { timeoutMs: 600_000 },
      );
      if (done.code !== 0) {
        await removeTemp(t, joined);
        throw errorFromResult(done);
      }
    }
  } catch (error) {
    await removePieces(part + 1);
    throw error;
  }
  return { bytes: declared };
}

/** Renames a finished temporary upload onto its final path. */
export async function moveIntoPlace(
  t: ListTarget,
  tempPath: string,
  finalPath: string,
  overwrite: boolean,
): Promise<void> {
  const moved = await runCommand(
    t.client,
    execScriptCommand(
      t.runtime,
      t.containerId,
      `if [ "$3" = 1 ] && [ -d "$2" ] && [ ! -L "$2" ]; then rm -rf -- "$2"; fi; mv -f -- "$1" "$2"`,
      [tempPath, finalPath, overwrite ? "1" : "0"],
    ),
    { timeoutMs: 60_000 },
  );
  if (moved.code !== 0) throw errorFromResult(moved);
}

/** Best-effort removal of a half-written temporary upload. */
export async function removeTemp(
  t: ListTarget,
  tempPath: string,
): Promise<void> {
  await runCommand(
    t.client,
    execScriptCommand(t.runtime, t.containerId, `rm -f -- "$1"`, [tempPath]),
    { timeoutMs: 15_000 },
  ).catch(() => {}); // best effort: a leftover temp file is harmless
}

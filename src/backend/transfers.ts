import { posix } from "node:path";
import { Transform, type Readable } from "node:stream";
import type { Request, Response } from "express";
import tar from "tar-stream";
import { cpError, cpUpload } from "./cp-io.js";
import {
  channelDone,
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
      throw new HttpError(409, "Transfer id already in use");
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
  done.catch(() => {});
  const onAbort = () => {
    channel.destroy();
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
    channel.destroy();
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
  const owner = await directoryOwner(t, params.dir, signal);

  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      transfer.bytes += chunk.length;
      cb(null, chunk);
    },
  });
  req.on("error", (e) => counter.destroy(e));
  req.on("aborted", () => transfer.controller.abort());
  req.pipe(counter);

  if (params.format === "tar") {
    await cpUpload(t, params.dir, sanitizeTar(counter, { owner }), signal);
    return { bytes: transfer.bytes };
  }

  const size = Number(req.headers["content-length"]);
  if (
    !Number.isFinite(size) ||
    size < 0 ||
    req.headers["content-length"] === undefined
  ) {
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
    ? posix.join(posix.dirname(rel), partName(transfer.id, posix.basename(rel)))
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
  ).catch(() => {});
}

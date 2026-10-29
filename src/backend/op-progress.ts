import { runCommand } from "./exec.js";
import type { ListTarget } from "./fs-list.js";
import { HttpError } from "./helpers.js";
import { execScriptCommand } from "./shell-quote.js";

/** Where a long archive operation currently is. */
export type OpStage =
  | "preparing"
  | "scanning"
  | "packing"
  | "extracting"
  | "rewriting"
  | "finishing";

export type OpStatus = "running" | "done" | "error" | "cancelled";

/** What `GET /operations/:id` reports. */
export interface OpProgressView {
  id: string;
  kind: "compress" | "extract" | "append" | "delete";
  status: OpStatus;
  stage: OpStage;
  /** Bytes done so far, when it can be measured. */
  processedBytes?: number;
  /** Expected bytes, when it can be estimated. */
  totalBytes?: number;
  /** True when `totalBytes` is only an estimate (e.g. compressed output). */
  approximate?: boolean;
  startedAt: number;
}

/** Progress of one running operation; the operation updates it, the poller reads it. */
export class OpProgress {
  stage: OpStage = "preparing";
  status: OpStatus = "running";
  processedBytes?: number;
  totalBytes?: number;
  approximate = false;
  readonly startedAt = Date.now();
  /** When the operation stopped running; unset while it runs. */
  finishedAt?: number;

  constructor(
    readonly id: string,
    readonly userId: string,
    readonly kind: "compress" | "extract" | "append" | "delete",
  ) {}

  setStage(stage: OpStage): void {
    if (this.status === "running") this.stage = stage;
  }

  setTotal(total: number | undefined, approximate = false): void {
    this.totalBytes = total !== undefined && total > 0 ? total : undefined;
    this.approximate = approximate;
  }

  setProcessed(bytes: number | undefined): void {
    if (this.status !== "running" || bytes === undefined) return;
    this.processedBytes = Math.max(0, bytes);
  }

  finish(error?: unknown): void {
    if (this.status !== "running") return;
    this.finishedAt = Date.now();
    if (error === undefined) this.status = "done";
    else if (error instanceof HttpError && error.code === "CANCELLED") {
      this.status = "cancelled";
    } else if (error instanceof Error && error.name === "AbortError") {
      this.status = "cancelled";
    } else this.status = "error";
  }

  view(): OpProgressView {
    return {
      id: this.id,
      kind: this.kind,
      status: this.status,
      stage: this.stage,
      processedBytes: this.processedBytes,
      totalBytes: this.totalBytes,
      approximate: this.totalBytes !== undefined ? this.approximate : undefined,
      startedAt: this.startedAt,
    };
  }
}

const MAX_TRACKED = 200;
/** A finished op stays readable this long before it may be evicted. */
const FINISHED_GRACE_MS = 60_000;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export class OpProgressRegistry {
  private ops = new Map<string, OpProgress>();

  /** An id that is missing or malformed is not an error: nothing is tracked. */
  start(
    id: unknown,
    userId: string,
    kind: OpProgress["kind"],
  ): OpProgress | undefined {
    if (typeof id !== "string" || !ID_RE.test(id)) return undefined;
    // Never disturb an entry another user owns or that is still running.
    const existing = this.ops.get(id);
    if (
      existing &&
      (existing.userId !== userId || existing.status === "running")
    ) {
      return undefined;
    }
    if (!existing && this.ops.size >= MAX_TRACKED && !this.evict()) {
      return undefined;
    }
    const progress = new OpProgress(id, userId, kind);
    this.ops.set(id, progress);
    return progress;
  }

  /** Drops finished ops past the grace period, oldest first; false if none. */
  private evict(): boolean {
    const cutoff = Date.now() - FINISHED_GRACE_MS;
    const stale = [...this.ops.values()]
      .filter((o) => o.finishedAt !== undefined && o.finishedAt <= cutoff)
      .sort((x, y) => x.finishedAt! - y.finishedAt!);
    for (const o of stale.slice(0, MAX_TRACKED / 4)) this.ops.delete(o.id);
    return stale.length > 0;
  }

  get(id: string, userId: string): OpProgress | undefined {
    const op = this.ops.get(id);
    return op && op.userId === userId ? op : undefined;
  }
}

// ---- parsing ------------------------------------------------------------

/** Sums the sizes `du -sk` prints (one "<kilobytes>\t<path>" line per path). */
export function parseDuKb(text: string): number | undefined {
  let sum = 0;
  let seen = false;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s/.exec(line);
    if (!m) continue;
    sum += Number(m[1]) * 1024;
    seen = true;
  }
  return seen ? sum : undefined;
}

/** The byte count `wc -c` prints. */
export function parseWcBytes(text: string): number | undefined {
  const m = /^\s*(\d+)\s*$/m.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** The uncompressed total in the last line of `unzip -l` ("  1234  3 files"). */
export function parseUnzipTotal(text: string): number | undefined {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const last = lines[lines.length - 1];
  const m = last && /^\s*(\d+)\s+\d+\s+files?\s*$/.exec(last);
  return m ? Number(m[1]) : undefined;
}

/** A percentage the UI may show: never 100 until the operation reports done. */
export function percentOf(view: {
  processedBytes?: number;
  totalBytes?: number;
}): number | undefined {
  if (!view.totalBytes || view.processedBytes === undefined) return undefined;
  return Math.min(
    99,
    Math.floor((view.processedBytes / view.totalBytes) * 100),
  );
}

// ---- probing ------------------------------------------------------------

const PROBE_TIMEOUT_MS = 15_000;

/** Runs a short read-only script; any failure (also a timeout) gives undefined. */
export async function probe(
  t: ListTarget,
  script: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await runCommand(
      t.client,
      execScriptCommand(t.runtime, t.containerId, script, args),
      { signal, timeoutMs: PROBE_TIMEOUT_MS, maxBytes: 1024 * 1024 },
    );
    return result.code === 0 ? result.stdout.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Disk usage of the given paths below `dir`, in bytes. */
export async function probeSize(
  t: ListTarget,
  dir: string,
  names: string[],
  signal?: AbortSignal,
): Promise<number | undefined> {
  const out = await probe(
    t,
    `cd -- "$1" || exit 1; shift; du -sk -- "$@" 2>/dev/null; exit 0`,
    [dir, ...names],
    signal,
  );
  return out === undefined ? undefined : parseDuKb(out);
}

export const PROGRESS_INTERVAL_MS = 700;

/**
 * Calls `measure` every interval (never overlapping) and feeds the result to
 * `progress`; returns the function that stops it.
 */
export function watchProgress(
  progress: OpProgress,
  measure: () => Promise<number | undefined>,
  intervalMs = PROGRESS_INTERVAL_MS,
): () => void {
  let stopped = false;
  let busy = false;
  const timer = setInterval(() => {
    if (busy || stopped) return;
    busy = true;
    measure()
      .then((n) => {
        if (!stopped) progress.setProcessed(n);
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

import type { OpStatus } from "./containerFsApi";

/** 65 seconds -> "1:05"; an hour or more -> "1:01:05". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** A whole percent, held below 100 until the operation really finishes. */
export function progressPercent(
  status: Pick<OpStatus, "processedBytes" | "totalBytes"> | null,
): number | undefined {
  if (!status?.totalBytes || status.processedBytes === undefined) {
    return undefined;
  }
  return Math.min(
    99,
    Math.max(0, Math.floor((status.processedBytes / status.totalBytes) * 100)),
  );
}

export function newOpId(kind: "compress" | "extract"): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Aborted by the user (not a failure). */
export class OpCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "OpCancelled";
  }
}

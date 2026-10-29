// How many files move at once; the bounds match the transferConcurrency user
// setting declared in manifest.json.
export const DEFAULT_TRANSFER_CONCURRENCY = 2;
const MIN_TRANSFER_CONCURRENCY = 1;
const MAX_TRANSFER_CONCURRENCY = 4;

export function transferConcurrency(setting: unknown): number {
  if (setting == null) return DEFAULT_TRANSFER_CONCURRENCY;
  const n = Math.floor(Number(setting));
  if (!Number.isFinite(n)) return DEFAULT_TRANSFER_CONCURRENCY;
  return Math.min(
    MAX_TRANSFER_CONCURRENCY,
    Math.max(MIN_TRANSFER_CONCURRENCY, n),
  );
}

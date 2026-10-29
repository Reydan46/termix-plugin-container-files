// Download progress shown in the viewer while a preview file is fetched.

export interface PreviewProgress {
  loaded: number;
  /** Absent when the server did not announce a size. */
  total?: number;
}

export interface PreviewProgressView {
  /** 0-100, or undefined when the total is unknown (indeterminate bar). */
  percent?: number;
  loaded: string;
  total?: string;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatTransferBytes(bytes: number): string {
  let size = Math.max(0, bytes);
  let unit = 0;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${unit === 0 ? Math.round(size) : size.toFixed(size < 10 ? 2 : 1)} ${UNITS[unit]}`;
}

export function describePreviewProgress(
  p: PreviewProgress,
): PreviewProgressView {
  if (!p.total || p.total <= 0)
    return { loaded: formatTransferBytes(p.loaded) };
  return {
    percent: Math.min(100, Math.floor((p.loaded / p.total) * 100)),
    loaded: formatTransferBytes(p.loaded),
    total: formatTransferBytes(p.total),
  };
}

/** Calls fn at most once per intervalMs; the first call goes through at once. */
export function throttleProgress<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs = 100,
  now: () => number = Date.now,
): (...args: A) => void {
  let last = -Infinity;
  return (...args) => {
    const t = now();
    if (t - last < intervalMs) return;
    last = t;
    fn(...args);
  };
}

// Shim: only the formatter of the upstream module is used.
export function formatTransferMbPerSec(
  mbPerSec?: number,
  _bytes?: number,
  _ms?: number,
): string {
  if (mbPerSec === undefined || mbPerSec <= 0) return "";
  if (mbPerSec < 1) return `${(mbPerSec * 1024).toFixed(0)} KB/s`;
  return `${mbPerSec.toFixed(1)} MB/s`;
}

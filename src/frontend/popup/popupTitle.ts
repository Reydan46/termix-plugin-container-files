/**
 * The one title format of every window: what it is first, then the
 * container it belongs to, then extra detail (a path, a shell):
 * "Archive — my-container · backup.tgz".
 */
export function popupTitle(parts: {
  what: string;
  container?: string;
  extra?: string;
}): string {
  const after = [parts.container, parts.extra]
    .map((p) => p?.trim() ?? "")
    .filter((p) => p !== "")
    .join(" · ");
  return after ? `${parts.what} — ${after}` : parts.what;
}

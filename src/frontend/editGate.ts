// Decides, before any editor window opens, whether a file may be edited as
// text, and carries the shim's "the backend refused this file" notices to the
// file manager so it can close the window and offer a download instead.

const MiB = 1024 * 1024;

/** Must equal the backend's EDITOR_MAX_BYTES (checked in tests). */
export const EDIT_LIMIT_BYTES = 5 * MiB;

export const EDIT_LIMIT_MIB = String(EDIT_LIMIT_BYTES / MiB);

export type EditGate =
  { ok: true } | { ok: false; sizeMiB: string; limitMiB: string };

function mib(bytes: number): string {
  const v = bytes / MiB;
  return v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
}

/**
 * `size` of 0 or undefined means unknown (or truly empty): such a file passes
 * and the backend's own check still applies.
 */
export function editGate(
  size: number | undefined,
  limit: number = EDIT_LIMIT_BYTES,
): EditGate {
  if (!size || size <= limit) return { ok: true };
  return { ok: false, sizeMiB: mib(size), limitMiB: mib(limit) };
}

export type EditRejection = "tooLarge" | "binary";

/** Returns true only when it owns the editor window for that session/path. */
type Listener = (
  sessionId: string,
  path: string,
  reason: EditRejection,
) => boolean;

const listeners = new Set<Listener>();

export function onEditRejected(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Returns true when a listener that owns that window took over (the window
 * will be closed). With no owner the caller must fail normally.
 */
export function notifyEditRejected(
  sessionId: string,
  path: string,
  reason: EditRejection,
): boolean {
  let handled = false;
  for (const l of [...listeners]) {
    if (handled) break;
    handled = l(sessionId, path, reason);
  }
  return handled;
}

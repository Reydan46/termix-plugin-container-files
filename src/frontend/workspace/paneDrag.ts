// Pane drag and drop: pure helpers so the fragile parts are testable.

export const PANE_DRAG_TYPE = "application/x-container-files-pane";

/** DataTransfer.types is a list in Chromium and a DOMStringList elsewhere. */
export function hasPaneDrag(types: ArrayLike<string> | null | undefined) {
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i].toLowerCase() === PANE_DRAG_TYPE) return true;
  }
  return false;
}

interface DragDataLike {
  setData: (format: string, data: string) => void;
  effectAllowed: string;
}

/**
 * Starts a pane drag. The browser only starts a drag when dragstart put data
 * on the DataTransfer, and it cancels the drag when the DOM changes inside
 * the handler: the caller's state update (which mounts the drop overlay) is
 * therefore deferred to a later task. Returns a cancel function for dragend.
 */
export function startPaneDrag(
  data: DragDataLike,
  paneId: string,
  onStarted: (paneId: string) => void,
  defer: (run: () => void) => () => void = (run) => {
    const timer = setTimeout(run, 0);
    return () => clearTimeout(timer);
  },
): () => void {
  data.setData(PANE_DRAG_TYPE, paneId);
  data.effectAllowed = "move";
  return defer(() => onStarted(paneId));
}

/** What the end of a pane drag knows. */
export interface DragEndState<T extends { kind: string }> {
  /** The target the preview last showed (null: no preview). */
  last: T | null;
  /** A drop already applied the pane (or the drag was already settled). */
  handled: boolean;
  /** Escape was pressed during the drag. */
  cancelled: boolean;
}

/**
 * Released outside every drop target the browser sends no `drop`, only
 * `dragend` (with dropEffect "none", so that cannot tell a release from
 * Escape). The release counts when the fill preview was showing, nothing
 * applied it yet and the drag was not cancelled. Returns what to apply.
 */
export function decideDragEnd<T extends { kind: string }>(
  s: DragEndState<T>,
): T | null {
  if (s.handled || s.cancelled) return null;
  return s.last && s.last.kind === "fill" ? s.last : null;
}

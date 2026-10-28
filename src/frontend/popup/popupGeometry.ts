/** A rectangle in client (viewport) coordinates. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a popup wants to appear. All coordinates are client coordinates.
 * - point: top-left a little below and right of the cursor
 * - over: on top of another box (a parent popup), same top-left corner
 * - center: centered in a box (the pane that owns the popup)
 */
export type PopupAnchor =
  | { kind: "point"; x: number; y: number }
  | { kind: "over"; rect: Box }
  | { kind: "center"; rect: Box };

export interface Placement {
  /** Position and size relative to the window container. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Default popup widths: roomy enough that labels and paths rarely wrap. */
export const POPUP_WIDTH = { compact: 480, normal: 560, wide: 640 } as const;

/** Space kept between a popup and the container edge. */
export const POPUP_MARGIN = 8;
/** Offset of a popup from the click that opened it. */
export const POINTER_OFFSET = 8;
/** A click older than this is not what opened the popup. */
export const POINTER_FRESH_MS = 3000;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, Math.max(min, max)));

/**
 * Computes the position and (possibly shrunk) size of a popup inside the
 * window container so it stays fully visible.
 */
export function placePopup(
  anchor: PopupAnchor | null,
  size: { width: number; height: number },
  container: Box,
  margin = POPUP_MARGIN,
): Placement {
  const width = Math.min(size.width, Math.max(0, container.width - 2 * margin));
  const height = Math.min(
    size.height,
    Math.max(0, container.height - 2 * margin),
  );
  let x: number;
  let y: number;
  if (anchor?.kind === "point") {
    x = anchor.x - container.left + POINTER_OFFSET;
    y = anchor.y - container.top + POINTER_OFFSET;
  } else if (anchor?.kind === "over") {
    x = anchor.rect.left - container.left;
    y = anchor.rect.top - container.top;
  } else {
    const box = anchor?.kind === "center" ? anchor.rect : container;
    x = box.left - container.left + (box.width - width) / 2;
    y = box.top - container.top + (box.height - height) / 2;
  }
  return {
    x: Math.round(clamp(x, margin, container.width - width - margin)),
    y: Math.round(clamp(y, margin, container.height - height - margin)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** The cursor as an anchor, or null when the last click is too old. */
export function pointerAnchor(
  pointer: { x: number; y: number; at: number } | null,
  now: number,
  maxAgeMs = POINTER_FRESH_MS,
): PopupAnchor | null {
  if (!pointer || now - pointer.at > maxAgeMs) return null;
  return { kind: "point", x: pointer.x, y: pointer.y };
}

/**
 * Picks the anchor for a new popup: over its parent popup, else centered in
 * the owning pane, else (no pane known) near the click that opened it.
 */
export function chooseAnchor(input: {
  parentRect: Box | null;
  pointer: { x: number; y: number; at: number } | null;
  now: number;
  paneRect: Box | null;
}): PopupAnchor | null {
  if (input.parentRect) return { kind: "over", rect: input.parentRect };
  if (input.paneRect) return { kind: "center", rect: input.paneRect };
  return pointerAnchor(input.pointer, input.now);
}

/** The element's rectangle in client coordinates, or null without one. */
export function boxOf(el: Element | null | undefined): Box | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/**
 * Where a window of `size` goes to sit centered over `pane`, relative to the
 * window layer (the container every managed window is positioned in).
 */
export function centerInPane(
  pane: Element | null | undefined,
  size: { width: number; height: number },
): Placement {
  const layer = document.querySelector(".window-container");
  const container = boxOf(layer) ?? {
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  };
  const rect = boxOf(pane);
  return placePopup(rect ? { kind: "center", rect } : null, size, container);
}

/**
 * Runs a mouse drag under a transparent full-screen overlay that carries the
 * cursor. Whatever sits under the pointer (a sortable header, a row, the
 * resize handle itself, which moves while the column grows) can no longer
 * change the cursor or receive hover, so the cursor stays one clean shape.
 * `onMove` gets the pointer x/y; `onEnd` runs once on mouse up (or `stop`).
 * Returns `stop`.
 */
export function dragWithOverlay(
  cursor: string,
  onMove: (x: number, y: number) => void,
  onEnd?: () => void,
): () => void {
  const overlay = document.createElement("div");
  overlay.setAttribute("data-drag-overlay", "");
  overlay.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483646;cursor:${cursor};background:transparent;user-select:none;`;
  document.body.appendChild(overlay);
  let done = false;
  const move = (e: MouseEvent) => onMove(e.clientX, e.clientY);
  const stop = () => {
    if (done) return;
    done = true;
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("mouseup", stop, true);
    window.removeEventListener("blur", stop);
    window.removeEventListener("pointercancel", stop, true);
    overlay.remove();
    onEnd?.();
  };
  window.addEventListener("mousemove", move, true);
  window.addEventListener("mouseup", stop, true);
  // Losing the window or the pointer mid-drag must not leave the overlay up.
  window.addEventListener("blur", stop);
  window.addEventListener("pointercancel", stop, true);
  return stop;
}

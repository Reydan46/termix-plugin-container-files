export interface PointerSample {
  x: number;
  y: number;
  at: number;
}

let last: PointerSample | null = null;

/** The last click, or null when a key was pressed since (keyboard-driven). */
export function lastPointer(): PointerSample | null {
  return last;
}

/** Starts recording clicks and key presses; returns the stop. */
export function trackPointer(): () => void {
  if (typeof document === "undefined") return () => {};
  const record = (e: MouseEvent) => {
    last = { x: e.clientX, y: e.clientY, at: Date.now() };
  };
  const clear = () => {
    last = null;
  };
  document.addEventListener("pointerdown", record, true);
  document.addEventListener("contextmenu", record, true);
  document.addEventListener("keydown", clear, true);
  return () => {
    document.removeEventListener("pointerdown", record, true);
    document.removeEventListener("contextmenu", record, true);
    document.removeEventListener("keydown", clear, true);
    last = null;
  };
}

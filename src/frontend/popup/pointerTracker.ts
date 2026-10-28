export interface PointerSample {
  x: number;
  y: number;
  at: number;
}

let last: PointerSample | null = null;
let installed = false;

/** The last click, or null when a key was pressed since (keyboard-driven). */
export function lastPointer(): PointerSample | null {
  return last;
}

function install(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const record = (e: MouseEvent) => {
    last = { x: e.clientX, y: e.clientY, at: Date.now() };
  };
  document.addEventListener("pointerdown", record, true);
  document.addEventListener("contextmenu", record, true);
  document.addEventListener(
    "keydown",
    () => {
      last = null;
    },
    true,
  );
}

install();

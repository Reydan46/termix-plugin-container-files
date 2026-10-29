// Pure key rules shared by the popup windows, kept apart from the DOM for testing.

/** What the DOM reports about the element that has focus. */
export interface KeyTarget {
  /** Upper-case tag name, "" when nothing is focused. */
  tag: string;
  /** The `type` of an input. */
  inputType?: string;
  /** The ARIA role of the element or its closest role holder. */
  role?: string;
  isContentEditable?: boolean;
  /** Inside a form: pressing Enter in its field submits it natively. */
  inForm?: boolean;
  /** Inside a code editor (CodeMirror and the like). */
  inEditor?: boolean;
}

export interface KeyInfo {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  defaultPrevented?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

const OWN_ENTER_ROLES = new Set([
  "button",
  "radio",
  "checkbox",
  "switch",
  "menuitem",
  "option",
  "tab",
  "link",
  "textbox-multiline",
]);
const OWN_ENTER_TAGS = new Set([
  "BUTTON",
  "A",
  "SELECT",
  "SUMMARY",
  "TEXTAREA",
]);
const OWN_ENTER_INPUTS = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "file",
  "image",
  "color",
  "range",
]);

/** A key press inside an IME composition belongs to the IME. */
function composing(e: KeyInfo): boolean {
  return e.isComposing === true || e.keyCode === 229;
}

/**
 * Whether Enter should activate the dialog's default button. Not when the key
 * is already handled, an IME is composing, a modifier is held, or the focused
 * element does something with Enter itself (a multi-line field or code editor,
 * another button, a field of a form that submits natively).
 */
export function shouldHandleEnter(e: KeyInfo, target: KeyTarget): boolean {
  if (e.key !== "Enter") return false;
  if (composing(e) || e.defaultPrevented) return false;
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
  if (target.isContentEditable || target.inEditor) return false;
  if (OWN_ENTER_TAGS.has(target.tag)) return false;
  if (target.role && OWN_ENTER_ROLES.has(target.role)) return false;
  if (target.tag === "INPUT") {
    if (OWN_ENTER_INPUTS.has(target.inputType ?? "text")) return false;
    if (target.inForm) return false;
  }
  return true;
}

/** Escape closes a dialog unless something already used it or an IME did. */
export function shouldHandleEscape(e: KeyInfo): boolean {
  return e.key === "Escape" && !composing(e) && !e.defaultPrevented;
}

export type DialogKeyAction = "primary" | "cancel" | null;

export function dialogKeyAction(
  e: KeyInfo,
  target: KeyTarget,
  topmost: boolean,
): DialogKeyAction {
  if (!topmost) return null;
  if (shouldHandleEscape(e)) return "cancel";
  if (shouldHandleEnter(e, target)) return "primary";
  return null;
}

/** Only the window with the highest z-index (not minimized) reacts to keys. */
export function isTopmostWindow(
  id: string,
  windows: readonly { id: string; zIndex: number; isMinimized?: boolean }[],
): boolean {
  const own = windows.find((w) => w.id === id);
  if (!own) return false;
  return !windows.some(
    (w) => w.id !== id && !w.isMinimized && w.zIndex > own.zIndex,
  );
}

export type ButtonOrientation = "horizontal" | "vertical" | "both";

const ARROW_STEP: Record<string, { dir: 1 | -1; axis: "h" | "v" }> = {
  ArrowLeft: { dir: -1, axis: "h" },
  ArrowRight: { dir: 1, axis: "h" },
  ArrowUp: { dir: -1, axis: "v" },
  ArrowDown: { dir: 1, axis: "v" },
};

/**
 * The button an arrow key selects next, like a native message box: wraps
 * around. `current` is -1 when no button has focus (Right/Down then pick the
 * first, Left/Up the last). Null for any other key, an arrow of the other
 * axis, or no buttons.
 */
export function nextButtonIndex(
  current: number,
  count: number,
  key: string,
  orientation: ButtonOrientation = "both",
): number | null {
  const step = ARROW_STEP[key];
  if (!step || count <= 0) return null;
  if (orientation === "horizontal" && step.axis !== "h") return null;
  if (orientation === "vertical" && step.axis !== "v") return null;
  if (current < 0 || current >= count) return step.dir === 1 ? 0 : count - 1;
  return (current + step.dir + count) % count;
}

/** Buttons in one row take Left/Right, in one column Up/Down, else all four. */
export function orientationOf(
  boxes: readonly {
    top: number;
    left: number;
    height: number;
    width: number;
  }[],
): ButtonOrientation {
  if (boxes.length < 2) return "both";
  const sameRow = boxes.every(
    (b) => Math.abs(b.top - boxes[0].top) < boxes[0].height / 2,
  );
  if (sameRow) return "horizontal";
  const sameColumn = boxes.every(
    (b) => Math.abs(b.left - boxes[0].left) < boxes[0].width / 2,
  );
  return sameColumn ? "vertical" : "both";
}

const ARROW_FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const ARROW_OWN_ROLES = new Set([
  "textbox",
  "textbox-multiline",
  "combobox",
  "listbox",
  "slider",
  "spinbutton",
  "radio",
  "tab",
  "menuitem",
  "option",
]);

/**
 * Whether an arrow key may move the button selection: only on the topmost
 * dialog, not while an IME composes, not when the key was already used, and
 * not when a field, select, editor or widget with its own arrow keys has focus.
 */
export function shouldHandleArrow(
  e: KeyInfo,
  target: KeyTarget,
  topmost: boolean,
): boolean {
  if (!topmost || !(e.key in ARROW_STEP)) return false;
  if (composing(e) || e.defaultPrevented) return false;
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
  if (target.isContentEditable || target.inEditor) return false;
  if (ARROW_FIELD_TAGS.has(target.tag)) return false;
  if (target.role && ARROW_OWN_ROLES.has(target.role)) return false;
  return true;
}

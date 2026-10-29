import { describe, expect, it } from "vitest";
import {
  dialogKeyAction,
  isTopmostWindow,
  nextButtonIndex,
  orientationOf,
  shouldHandleArrow,
  shouldHandleEnter,
  shouldHandleEscape,
} from "../../src/frontend/popup/dialogKeys";

const enter = { key: "Enter" };

describe("shouldHandleEnter", () => {
  it("handles Enter on the body, a text field outside a form or a plain element", () => {
    expect(shouldHandleEnter(enter, { tag: "BODY" })).toBe(true);
    expect(shouldHandleEnter(enter, { tag: "DIV" })).toBe(true);
    expect(shouldHandleEnter(enter, { tag: "INPUT", inputType: "text" })).toBe(
      true,
    );
  });
  it("leaves a text field of a form to the native submit", () => {
    expect(
      shouldHandleEnter(enter, {
        tag: "INPUT",
        inputType: "text",
        inForm: true,
      }),
    ).toBe(false);
  });
  it("ignores multi-line fields and code editors", () => {
    expect(shouldHandleEnter(enter, { tag: "TEXTAREA" })).toBe(false);
    expect(shouldHandleEnter(enter, { tag: "DIV", inEditor: true })).toBe(
      false,
    );
    expect(
      shouldHandleEnter(enter, { tag: "DIV", isContentEditable: true }),
    ).toBe(false);
    expect(
      shouldHandleEnter(enter, { tag: "DIV", role: "textbox-multiline" }),
    ).toBe(false);
  });
  it("leaves other focused buttons to their own click", () => {
    expect(shouldHandleEnter(enter, { tag: "BUTTON" })).toBe(false);
    expect(shouldHandleEnter(enter, { tag: "DIV", role: "radio" })).toBe(false);
    expect(
      shouldHandleEnter(enter, { tag: "INPUT", inputType: "checkbox" }),
    ).toBe(false);
    expect(shouldHandleEnter(enter, { tag: "A" })).toBe(false);
  });
  it("ignores IME composition, handled keys and modifiers", () => {
    const body = { tag: "BODY" };
    expect(shouldHandleEnter({ key: "Enter", isComposing: true }, body)).toBe(
      false,
    );
    expect(shouldHandleEnter({ key: "Enter", keyCode: 229 }, body)).toBe(false);
    expect(
      shouldHandleEnter({ key: "Enter", defaultPrevented: true }, body),
    ).toBe(false);
    expect(shouldHandleEnter({ key: "Enter", shiftKey: true }, body)).toBe(
      false,
    );
    expect(shouldHandleEnter({ key: "Enter", ctrlKey: true }, body)).toBe(
      false,
    );
    expect(shouldHandleEnter({ key: "a" }, body)).toBe(false);
  });
});

describe("shouldHandleEscape", () => {
  it("closes unless composing or already handled", () => {
    expect(shouldHandleEscape({ key: "Escape" })).toBe(true);
    expect(shouldHandleEscape({ key: "Escape", isComposing: true })).toBe(
      false,
    );
    expect(shouldHandleEscape({ key: "Escape", defaultPrevented: true })).toBe(
      false,
    );
  });
});

describe("dialogKeyAction", () => {
  it("answers only on the topmost dialog", () => {
    expect(dialogKeyAction(enter, { tag: "BODY" }, false)).toBeNull();
    expect(
      dialogKeyAction({ key: "Escape" }, { tag: "BODY" }, false),
    ).toBeNull();
  });
  it("maps Enter to primary and Escape to cancel, even in a textarea", () => {
    expect(dialogKeyAction(enter, { tag: "BODY" }, true)).toBe("primary");
    expect(dialogKeyAction({ key: "Escape" }, { tag: "TEXTAREA" }, true)).toBe(
      "cancel",
    );
    expect(dialogKeyAction(enter, { tag: "TEXTAREA" }, true)).toBeNull();
  });
});

describe("isTopmostWindow", () => {
  const ws = [
    { id: "a", zIndex: 1 },
    { id: "b", zIndex: 3 },
    { id: "c", zIndex: 5, isMinimized: true },
  ];
  it("is the highest visible window", () => {
    expect(isTopmostWindow("b", ws)).toBe(true);
    expect(isTopmostWindow("a", ws)).toBe(false);
  });
  it("is false for an unknown window", () => {
    expect(isTopmostWindow("x", ws)).toBe(false);
  });
});

describe("nextButtonIndex", () => {
  it("moves with Left/Right and wraps around", () => {
    expect(nextButtonIndex(0, 3, "ArrowRight", "horizontal")).toBe(1);
    expect(nextButtonIndex(2, 3, "ArrowRight", "horizontal")).toBe(0);
    expect(nextButtonIndex(0, 3, "ArrowLeft", "horizontal")).toBe(2);
  });
  it("ignores the other axis and other keys", () => {
    expect(nextButtonIndex(0, 3, "ArrowDown", "horizontal")).toBeNull();
    expect(nextButtonIndex(0, 3, "ArrowRight", "vertical")).toBeNull();
    expect(nextButtonIndex(0, 3, "ArrowDown", "vertical")).toBe(1);
    expect(nextButtonIndex(0, 3, "ArrowUp", "vertical")).toBe(2);
    expect(nextButtonIndex(0, 3, "Tab")).toBeNull();
    expect(nextButtonIndex(0, 0, "ArrowRight")).toBeNull();
  });
  it("picks the first or last button when none is focused", () => {
    expect(nextButtonIndex(-1, 3, "ArrowRight")).toBe(0);
    expect(nextButtonIndex(-1, 3, "ArrowLeft")).toBe(2);
    expect(nextButtonIndex(0, 1, "ArrowRight")).toBe(0);
  });
  it("takes all four arrows for a grid", () => {
    expect(nextButtonIndex(0, 2, "ArrowUp", "both")).toBe(1);
    expect(nextButtonIndex(0, 2, "ArrowRight", "both")).toBe(1);
  });
});

describe("orientationOf", () => {
  const box = (top: number, left: number) => ({
    top,
    left,
    height: 20,
    width: 60,
  });
  it("tells a row, a column and a wrapped grid apart", () => {
    expect(orientationOf([box(0, 0), box(2, 70)])).toBe("horizontal");
    expect(orientationOf([box(0, 0), box(30, 3)])).toBe("vertical");
    expect(orientationOf([box(0, 0), box(0, 70), box(30, 0)])).toBe("both");
    expect(orientationOf([box(0, 0)])).toBe("both");
  });
});

describe("shouldHandleArrow", () => {
  const right = { key: "ArrowRight" };
  const button = { tag: "BUTTON" };
  it("handles arrows on a button or the dialog", () => {
    expect(shouldHandleArrow(right, button, true)).toBe(true);
    expect(shouldHandleArrow(right, { tag: "DIV" }, true)).toBe(true);
  });
  it("ignores fields, editors, selects and other widgets", () => {
    expect(shouldHandleArrow(right, { tag: "INPUT" }, true)).toBe(false);
    expect(shouldHandleArrow(right, { tag: "TEXTAREA" }, true)).toBe(false);
    expect(shouldHandleArrow(right, { tag: "SELECT" }, true)).toBe(false);
    expect(shouldHandleArrow(right, { tag: "DIV", inEditor: true }, true)).toBe(
      false,
    );
    expect(
      shouldHandleArrow(right, { tag: "DIV", isContentEditable: true }, true),
    ).toBe(false);
    expect(
      shouldHandleArrow(right, { tag: "DIV", role: "listbox" }, true),
    ).toBe(false);
  });
  it("ignores composing, handled, modified keys and a dialog below the top", () => {
    expect(
      shouldHandleArrow({ ...right, isComposing: true }, button, true),
    ).toBe(false);
    expect(shouldHandleArrow({ ...right, keyCode: 229 }, button, true)).toBe(
      false,
    );
    expect(
      shouldHandleArrow({ ...right, defaultPrevented: true }, button, true),
    ).toBe(false);
    expect(shouldHandleArrow({ ...right, shiftKey: true }, button, true)).toBe(
      false,
    );
    expect(shouldHandleArrow(right, button, false)).toBe(false);
    expect(shouldHandleArrow({ key: "Enter" }, button, true)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  ConfirmStack,
  confirmKeyAction,
} from "../../src/frontend/popup/confirmKeys";

const els = { confirmEl: "ok", cancelEl: "no", body: "body" };
const act = (
  key: string,
  active: string | null,
  topmost = true,
  repeat = false,
) => confirmKeyAction<string>({ key, topmost, repeat, active, ...els });

describe("confirmKeyAction", () => {
  it("confirms on Enter from the confirm button, body or nothing", () => {
    expect(act("Enter", "ok")).toBe("confirm");
    expect(act("Enter", "body")).toBe("confirm");
    expect(act("Enter", null)).toBe("confirm");
  });
  it("cancels, never confirms, on Enter while Cancel is focused", () => {
    expect(act("Enter", "no")).toBe("cancel");
  });
  it("only moves the focus back for Enter from elsewhere", () => {
    expect(act("Enter", "terminal")).toBe("refocus");
    expect(act("Enter", "grid")).toBe("refocus");
  });
  it("does not answer a held Enter", () => {
    expect(act("Enter", "ok", true, true)).toBe("swallow");
    expect(act("Enter", null, true, true)).toBe("swallow");
    expect(act("Enter", "no", true, true)).toBe("swallow");
  });
  it("cancels on Escape wherever the focus is", () => {
    expect(act("Escape", "ok")).toBe("cancel");
    expect(act("Escape", "no")).toBe("cancel");
    expect(act("Escape", "grid")).toBe("cancel");
  });
  it("swallows every other key so it cannot reach the file pane", () => {
    for (const key of [
      "Delete",
      "ArrowDown",
      "ArrowUp",
      " ",
      "a",
      "F2",
      "Backspace",
      "Tab",
    ])
      expect(act(key, "ok")).toBe("swallow");
  });
  it("ignores all keys when the card is not the topmost one", () => {
    expect(act("Enter", "ok", false)).toBeNull();
    expect(act("Escape", "ok", false)).toBeNull();
    expect(act("a", "ok", false)).toBeNull();
  });
});

// A no-DOM model of the event path: the confirm card listens in the capture
// phase of `window`; the file pane listens on `document` (bubble). A card that
// handles a key stops it, so the pane only sees what the card passed on.
describe("a key pressed while a confirm is open", () => {
  const route = (key: string, active: string | null) => {
    let reachedPane = false;
    const action = confirmKeyAction<string>({
      key,
      topmost: true,
      active,
      ...els,
    });
    if (action === null) reachedPane = true; // not stopped by the card
    return { action, reachedPane };
  };
  const KEYS = [
    "Enter",
    "Escape",
    "Delete",
    "F2",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    " ",
    "a",
    "Backspace",
  ];
  const FOCUS = ["ok", "no", "body", "grid", null];

  it("never reaches the file pane, whichever key and focus", () => {
    for (const key of KEYS)
      for (const active of FOCUS)
        expect(route(key, active).reachedPane).toBe(false);
  });
});

describe("ConfirmStack", () => {
  it("only the last pushed card is topmost", () => {
    const s = new ConfirmStack();
    const a = s.push();
    const b = s.push();
    expect(s.isTop(a)).toBe(false);
    expect(s.isTop(b)).toBe(true);
    s.remove(b);
    expect(s.isTop(a)).toBe(true);
  });
});

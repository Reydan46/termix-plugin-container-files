import { describe, expect, it } from "vitest";
import {
  ConfirmStack,
  confirmKeyAction,
} from "../../src/frontend/popup/confirmKeys";

const els = { confirmEl: "ok", cancelEl: "no", body: "body" };
const act = (key: string, active: string | null, topmost = true) =>
  confirmKeyAction<string>({ key, topmost, active, ...els });

describe("confirmKeyAction", () => {
  it("confirms on Enter from the confirm button, body or nothing", () => {
    expect(act("Enter", "ok")).toBe("confirm");
    expect(act("Enter", "body")).toBe("confirm");
    expect(act("Enter", null)).toBe("confirm");
  });
  it("never confirms when Cancel is focused", () => {
    expect(act("Enter", "no")).toBe("native");
  });
  it("swallows Enter from elsewhere without confirming", () => {
    expect(act("Enter", "terminal")).toBe("block");
  });
  it("cancels on Escape wherever the focus is", () => {
    expect(act("Escape", "ok")).toBe("cancel");
    expect(act("Escape", "no")).toBe("cancel");
  });
  it("ignores other keys and non-topmost cards", () => {
    expect(act("a", "ok")).toBeNull();
    expect(act("Enter", "ok", false)).toBeNull();
    expect(act("Escape", "ok", false)).toBeNull();
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

import { describe, expect, it, vi } from "vitest";
import { nextActivePane, ownsKeys } from "../../src/frontend/paneFocus";

describe("pane focus", () => {
  it("a press inside a pane makes it the active one", () => {
    expect(nextActivePane("a", "b", false)).toBe("b");
    expect(nextActivePane(null, "a", false)).toBe("a");
  });

  it("a press in a confirm card keeps the active pane", () => {
    expect(nextActivePane("a", null, true)).toBe("a");
  });

  it("a press outside every pane clears it", () => {
    expect(nextActivePane("a", null, false)).toBeNull();
  });

  it("only the active pane handles keys", () => {
    expect(ownsKeys("a", "a")).toBe(true);
    expect(ownsKeys("a", "b")).toBe(false);
    expect(ownsKeys("a", null)).toBe(false);
    expect(ownsKeys(null, "b")).toBe(true);
  });
});

describe("pane tracking lifecycle", () => {
  it("adds its document listeners on start and removes them on stop", async () => {
    const calls: string[] = [];
    const fake = {
      addEventListener: (type: string) => calls.push(`add ${type}`),
      removeEventListener: (type: string) => calls.push(`remove ${type}`),
    };
    vi.stubGlobal("document", fake);
    try {
      const { trackActivePane } = await import("../../src/frontend/paneFocus");
      expect(calls).toEqual([]);
      const stop = trackActivePane();
      expect(calls).toEqual(["add pointerdown", "add focusin"]);
      stop();
      expect(calls.slice(2).sort()).toEqual([
        "remove focusin",
        "remove pointerdown",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

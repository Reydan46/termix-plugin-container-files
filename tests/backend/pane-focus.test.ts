import { describe, expect, it } from "vitest";
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

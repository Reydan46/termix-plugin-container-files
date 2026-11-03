import { describe, expect, it, vi } from "vitest";

describe("pointer tracking lifecycle", () => {
  it("adds no listener on import, adds on start and removes on stop", async () => {
    const calls: string[] = [];
    vi.stubGlobal("document", {
      addEventListener: (type: string) => calls.push(`add ${type}`),
      removeEventListener: (type: string) => calls.push(`remove ${type}`),
    });
    try {
      const { trackPointer } =
        await import("../../src/frontend/popup/pointerTracker");
      expect(calls).toEqual([]);
      const stop = trackPointer();
      expect(calls.sort()).toEqual([
        "add contextmenu",
        "add keydown",
        "add pointerdown",
      ]);
      calls.length = 0;
      stop();
      expect(calls.sort()).toEqual([
        "remove contextmenu",
        "remove keydown",
        "remove pointerdown",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

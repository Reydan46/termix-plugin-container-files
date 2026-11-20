import { describe, expect, it } from "vitest";
import { TransferRegistry } from "../../src/backend/transfers";

describe("transfer id reuse", () => {
  it("lets the same user retry a running id and stops the stale transfer", () => {
    const registry = new TransferRegistry();
    const first = registry.start("up-abc12345", "u1", "upload", 10);
    const second = registry.start("up-abc12345", "u1", "upload", 10);
    expect(first.state).toBe("cancelled");
    expect(first.controller.signal.aborted).toBe(true);
    expect(second.state).toBe("running");
    expect(second.part).not.toBe(first.part);
    // The stale request finishing late must not touch the new transfer.
    registry.finish(first, new Error("aborted"));
    expect(registry.get("up-abc12345", "u1")).toBe(second);
    expect(second.state).toBe("running");
  });

  it("still refuses an id that another user is running", () => {
    const registry = new TransferRegistry();
    registry.start("up-abc12345", "u1", "upload", 10);
    expect(() => registry.start("up-abc12345", "u2", "upload", 10)).toThrow(
      /already in use/,
    );
  });
});

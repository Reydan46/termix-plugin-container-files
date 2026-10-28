import { describe, expect, it } from "vitest";
import { mustRaiseOverParent } from "../../src/frontend/popup/popupFamily";

describe("mustRaiseOverParent", () => {
  it("raises a child that fell under (or level with) its owner", () => {
    expect(mustRaiseOverParent(1010, 1005)).toBe(true);
    expect(mustRaiseOverParent(1005, 1005)).toBe(true);
  });
  it("leaves a child that is already above, or has no owner", () => {
    expect(mustRaiseOverParent(1005, 1010)).toBe(false);
    expect(mustRaiseOverParent(undefined, 1005)).toBe(false);
  });
});

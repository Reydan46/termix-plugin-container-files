import { describe, expect, it } from "vitest";
import { transferConcurrency } from "../../src/frontend/transferConcurrency";

describe("transferConcurrency", () => {
  it("falls back to the default when the setting is missing or not a number", () => {
    expect(transferConcurrency(undefined)).toBe(2);
    expect(transferConcurrency(null)).toBe(2);
    expect(transferConcurrency("abc")).toBe(2);
  });

  it("keeps the value inside the range the manifest allows", () => {
    expect(transferConcurrency(1)).toBe(1);
    expect(transferConcurrency(3)).toBe(3);
    expect(transferConcurrency(4)).toBe(4);
    expect(transferConcurrency(0)).toBe(1);
    expect(transferConcurrency(-5)).toBe(1);
    expect(transferConcurrency(9)).toBe(4);
    expect(transferConcurrency(2.9)).toBe(2);
  });
});

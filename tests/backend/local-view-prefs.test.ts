import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW_PREFS,
  gridColumns,
  parseViewPrefs,
  serializeViewPrefs,
  viewMetrics,
} from "../../src/frontend/localViewPrefs";

describe("parseViewPrefs", () => {
  it("falls back to defaults", () => {
    expect(parseViewPrefs(null)).toEqual(DEFAULT_VIEW_PREFS);
    expect(parseViewPrefs("")).toEqual(DEFAULT_VIEW_PREFS);
    expect(parseViewPrefs("{oops")).toEqual(DEFAULT_VIEW_PREFS);
    expect(parseViewPrefs("42")).toEqual(DEFAULT_VIEW_PREFS);
  });

  it("reads valid fields and ignores bad ones", () => {
    expect(parseViewPrefs('{"viewMode":"grid","density":"compact"}')).toEqual({
      viewMode: "grid",
      density: "compact",
    });
    expect(parseViewPrefs('{"viewMode":"tiles","density":"compact"}')).toEqual({
      viewMode: "list",
      density: "compact",
    });
  });

  it("round-trips", () => {
    const prefs = { viewMode: "grid", density: "compact" } as const;
    expect(parseViewPrefs(serializeViewPrefs(prefs))).toEqual(prefs);
  });
});

describe("gridColumns", () => {
  it("is clamped to 2..10", () => {
    expect(gridColumns(0, "comfortable")).toBe(2);
    expect(gridColumns(NaN, "comfortable")).toBe(2);
    expect(gridColumns(10000, "compact")).toBe(10);
  });

  it("counts cells that fit", () => {
    // (600 - 32 + 16) / 112 = 5.2
    expect(gridColumns(600, "comfortable")).toBe(5);
    // (600 - 16 + 8) / 76 = 7.8
    expect(gridColumns(600, "compact")).toBe(7);
  });
});

describe("viewMetrics", () => {
  it("matches the container grid", () => {
    expect(viewMetrics("comfortable").listRowHeight).toBe(41);
    expect(viewMetrics("compact").listRowHeight).toBe(29);
  });
});

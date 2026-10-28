import { describe, expect, it } from "vitest";
import {
  extractDestValid,
  parentDir,
  startDir,
} from "../../src/frontend/pathHelpers";

describe("path picker helpers", () => {
  it("finds the folder a picker starts in", () => {
    expect(startDir("/a/b/", true)).toBe("/a/b");
    expect(startDir("/a/b/c.txt", false)).toBe("/a/b");
    expect(startDir("rel/path", true)).toBe("/");
    expect(startDir("", false)).toBe("/");
    expect(parentDir("/a")).toBe("/");
  });

  it("validates extract destinations", () => {
    expect(extractDestValid("/srv/app")).toBe(true);
    expect(extractDestValid("relative")).toBe(false);
    expect(extractDestValid("/a.tgz!/x")).toBe(false);
    expect(extractDestValid("  ")).toBe(false);
  });
});

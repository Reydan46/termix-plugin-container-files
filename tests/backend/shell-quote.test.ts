import { describe, expect, it } from "vitest";
import {
  engineCommand,
  execScriptCommand,
  safeName,
  safePath,
  safeRelative,
  shq,
} from "../../src/backend/shell-quote";
import { HttpError } from "../../src/backend/helpers";

describe("shq", () => {
  it("wraps in single quotes and escapes embedded ones", () => {
    expect(shq("a b")).toBe("'a b'");
    expect(shq("it's")).toBe(`'it'\\''s'`);
    expect(shq("$(rm -rf /); `x`")).toBe("'$(rm -rf /); `x`'");
  });

  it("rejects NUL", () => {
    expect(() => shq("a\0b")).toThrow(HttpError);
  });
});

describe("commands", () => {
  it("quotes every engine argument", () => {
    const cmd = engineCommand("docker", ["cp", "id:/a b", "-"]);
    expect(cmd).toMatch(/ docker 'cp' 'id:\/a b' '-'$/);
    expect(cmd.startsWith('PATH="')).toBe(true);
  });

  it("passes script values as positional parameters only", () => {
    const cmd = execScriptCommand("podman", "abc", 'ls "$1"', [
      "/x'; rm -rf /",
    ]);
    expect(cmd).toContain(
      `podman 'exec' 'abc' 'sh' '-c' 'ls "$1"' '_' '/x'\\''; rm -rf /'`,
    );
    expect(
      execScriptCommand("docker", "abc", "cat", [], { interactive: true }),
    ).toContain("'exec' '-i' 'abc'");
  });
});

describe("path helpers", () => {
  it("normalizes paths", () => {
    expect(safePath("/a/b/../c/")).toBe("/a/c");
    expect(safePath("relative")).toBe("/relative");
    expect(safePath("/")).toBe("/");
    expect(safePath("//etc//")).toBe("/etc");
  });

  it("rejects bad paths", () => {
    expect(() => safePath("")).toThrow(HttpError);
    expect(() => safePath("/a\0b")).toThrow(HttpError);
    expect(() => safePath(5)).toThrow(HttpError);
    expect(() => safePath(`/${"a".repeat(5000)}`)).toThrow(HttpError);
  });

  it("validates names and relative paths", () => {
    expect(safeName("ok.txt")).toBe("ok.txt");
    for (const bad of ["", ".", "..", "a/b", "a\0"]) {
      expect(() => safeName(bad)).toThrow(HttpError);
    }
    expect(safeRelative("a/./b//c")).toBe("a/b/c");
    expect(() => safeRelative("a/../b")).toThrow(HttpError);
    expect(() => safeRelative("/")).toThrow(HttpError);
  });
});

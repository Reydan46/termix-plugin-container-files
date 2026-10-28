import { describe, expect, it } from "vitest";
import {
  MODE_ACCESS,
  MODE_CLASSES,
  MODE_SPECIAL,
  formatMode,
  hasAccess,
  hasSpecial,
  parseMode,
  parseOctalMode,
  sanitizeOctalInput,
  setAccess,
  setSpecial,
} from "../../src/frontend/permissionMode";

describe("permission mode helpers", () => {
  it("parses complete octal text with 3 or 4 digits only", () => {
    expect(parseOctalMode("755")).toBe(0o755);
    expect(parseOctalMode("0755")).toBe(0o755);
    expect(parseOctalMode("4755")).toBe(0o4755);
    expect(parseOctalMode("1777")).toBe(0o1777);
    for (const bad of ["", "7", "75", "758", "12345", "7a5", "-755", "7 5"])
      expect(parseOctalMode(bad)).toBeNull();
  });

  it("keeps only digits 0-7, at most four", () => {
    expect(sanitizeOctalInput("7a5-5")).toBe("755");
    expect(sanitizeOctalInput("89")).toBe("");
    expect(sanitizeOctalInput("47550")).toBe("4755");
    expect(sanitizeOctalInput(" 07 55")).toBe("0755");
  });

  it("formats as four octal digits", () => {
    expect(formatMode(0o755)).toBe("0755");
    expect(formatMode(0o4755)).toBe("4755");
    expect(formatMode(0o1777)).toBe("1777");
    expect(formatMode(0)).toBe("0000");
    expect(formatMode(0o170755)).toBe("0755");
  });

  it("reads modes from the listing: octal and symbolic", () => {
    expect(parseMode("644")).toBe(0o644);
    expect(parseMode("4755")).toBe(0o4755);
    expect(parseMode("-rwxr-xr-x")).toBe(0o755);
    expect(parseMode("rwsr-xr-x")).toBe(0o4755);
    expect(parseMode("rwxrwsr-x")).toBe(0o2775);
    expect(parseMode("rwxrwxrwt")).toBe(0o1777);
    expect(parseMode("rwSr--r-T")).toBe(0o5644);
    expect(parseMode("garbage")).toBe(0o644);
    expect(parseMode(undefined)).toBe(0o644);
  });

  it("toggles single bits without touching the others", () => {
    let mode = 0o644;
    mode = setAccess(mode, "owner", "execute", true);
    expect(mode).toBe(0o744);
    mode = setAccess(mode, "other", "read", false);
    expect(mode).toBe(0o740);
    mode = setSpecial(mode, "setuid", true);
    mode = setSpecial(mode, "sticky", true);
    expect(formatMode(mode)).toBe("5740");
    mode = setSpecial(mode, "setuid", false);
    expect(formatMode(mode)).toBe("1740");
    expect(hasSpecial(mode, "sticky")).toBe(true);
    expect(hasSpecial(mode, "setgid")).toBe(false);
  });

  it("round-trips every mode through the grid and the text", () => {
    for (const mode of [0, 0o644, 0o755, 0o4755, 0o2775, 0o1777, 0o7777]) {
      let rebuilt = 0;
      for (const cls of MODE_CLASSES)
        for (const access of MODE_ACCESS)
          rebuilt = setAccess(
            rebuilt,
            cls,
            access,
            hasAccess(mode, cls, access),
          );
      for (const s of MODE_SPECIAL)
        rebuilt = setSpecial(rebuilt, s, hasSpecial(mode, s));
      expect(rebuilt).toBe(mode);
      expect(parseOctalMode(formatMode(mode))).toBe(mode);
    }
  });
});

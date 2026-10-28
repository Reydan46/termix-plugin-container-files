import { describe, expect, it } from "vitest";
import {
  EDIT_LIMIT_BYTES,
  editGate,
  notifyEditRejected,
  onEditRejected,
} from "../../src/frontend/editGate";
import { EDITOR_MAX_BYTES } from "../../src/backend/fs-read-write";

const MiB = 1024 * 1024;

describe("editGate", () => {
  it("matches the backend limit", () => {
    expect(EDIT_LIMIT_BYTES).toBe(EDITOR_MAX_BYTES);
  });
  it("passes unknown, empty and small sizes", () => {
    expect(editGate(undefined).ok).toBe(true);
    expect(editGate(0).ok).toBe(true);
    expect(editGate(EDIT_LIMIT_BYTES).ok).toBe(true);
  });
  it("rejects files over the limit with MiB figures", () => {
    expect(editGate(EDIT_LIMIT_BYTES + 1)).toEqual({
      ok: false,
      sizeMiB: "5",
      limitMiB: "5",
    });
    expect(editGate(120 * MiB)).toEqual({
      ok: false,
      sizeMiB: "120",
      limitMiB: "5",
    });
    expect(editGate(7.5 * MiB)).toMatchObject({ sizeMiB: "7.5" });
  });
});

describe("edit rejection notices", () => {
  it("reaches listeners and reports whether anyone took over", () => {
    expect(notifyEditRejected("s", "/a", "binary")).toBe(false);
    const seen: string[] = [];
    const off = onEditRejected((s, p, r) => {
      seen.push(`${s}|${p}|${r}`);
      return true;
    });
    expect(notifyEditRejected("s", "/a", "tooLarge")).toBe(true);
    off();
    expect(seen).toEqual(["s|/a|tooLarge"]);
  });
  it("is not handled by a listener that does not own the window", () => {
    const off = onEditRejected(() => false);
    expect(notifyEditRejected("s", "/a", "binary")).toBe(false);
    off();
  });
  it("stops at the first owner", () => {
    let second = 0;
    const a = onEditRejected(() => true);
    const b = onEditRejected(() => {
      second++;
      return true;
    });
    expect(notifyEditRejected("s", "/a", "binary")).toBe(true);
    a();
    b();
    expect(second).toBe(0);
  });
});

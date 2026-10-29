import { describe, expect, it } from "vitest";
import {
  MAX_OS_COPY_BYTES,
  clipboardWinner,
  exceedsCopyCap,
  extractPasteFiles,
  ignoresPaste,
  knownBytes,
  looksLikeFolder,
  pasteTargetDir,
  supportsOsFileClipboard,
} from "../../src/frontend/osClipboard";

const file = (name: string, size = 3, type = "text/plain", at = 1) =>
  ({ name, size, type, lastModified: at }) as unknown as File;

describe("extractPasteFiles", () => {
  it("is empty without data or files", () => {
    expect(extractPasteFiles(null)).toEqual([]);
    expect(extractPasteFiles({ files: [] })).toEqual([]);
  });
  it("takes clipboardData.files", () => {
    const a = file("a.txt");
    expect(extractPasteFiles({ files: [a] })).toEqual([a]);
  });
  it("falls back to file items and ignores strings", () => {
    const a = file("a.txt");
    const out = extractPasteFiles({
      files: [],
      items: [
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => a },
      ],
    });
    expect(out).toEqual([a]);
  });
  it("drops duplicates", () => {
    expect(
      extractPasteFiles({ files: [file("a.txt"), file("a.txt")] }),
    ).toHaveLength(1);
  });
});

describe("folder hint and targets", () => {
  it("flags empty typeless files without extension", () => {
    expect(looksLikeFolder(file("Photos", 0, ""))).toBe(true);
    expect(looksLikeFolder(file("a.txt", 0, ""))).toBe(false);
    expect(looksLikeFolder(file("Photos", 5, ""))).toBe(false);
  });
  it("pastes into a single selected folder, else the current one", () => {
    const dir = { path: "/x/d", type: "directory" };
    const f = { path: "/x/f", type: "file" };
    expect(pasteTargetDir("/x", [dir])).toBe("/x/d");
    expect(pasteTargetDir("/x", [f])).toBe("/x");
    expect(pasteTargetDir("/x", [dir, dir])).toBe("/x");
    expect(pasteTargetDir("/x", [])).toBe("/x");
  });
  it("ignores pastes while typing or in dialogs", () => {
    expect(ignoresPaste(null)).toBe(false);
    expect(ignoresPaste({ closest: () => null })).toBe(false);
    expect(ignoresPaste({ closest: () => ({}) })).toBe(true);
  });
});

describe("clipboardWinner", () => {
  it("OS wins without an internal clipboard", () => {
    expect(
      clipboardWinner({ hasInternal: false, internalAt: 9, osAt: 1 }),
    ).toBe("os");
  });
  it("the one set last wins", () => {
    expect(clipboardWinner({ hasInternal: true, internalAt: 5, osAt: 3 })).toBe(
      "internal",
    );
    expect(clipboardWinner({ hasInternal: true, internalAt: 3, osAt: 5 })).toBe(
      "os",
    );
    expect(clipboardWinner({ hasInternal: true, internalAt: 3, osAt: 3 })).toBe(
      "os",
    );
  });
});

describe("copy cap and platform", () => {
  it("counts known file bytes only", () => {
    expect(
      knownBytes([
        { type: "file", size: 10 },
        { type: "directory", size: 4096 },
        { type: "file" },
      ]),
    ).toBe(10);
  });
  it("refuses over 512 MB", () => {
    expect(MAX_OS_COPY_BYTES).toBe(512 * 1024 * 1024);
    expect(exceedsCopyCap(MAX_OS_COPY_BYTES)).toBe(false);
    expect(exceedsCopyCap(MAX_OS_COPY_BYTES + 1)).toBe(true);
  });
  it("supports Windows only", () => {
    expect(supportsOsFileClipboard("win32")).toBe(true);
    for (const p of ["darwin", "linux", "", null, undefined])
      expect(supportsOsFileClipboard(p)).toBe(false);
  });
});

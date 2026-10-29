import { describe, expect, it } from "vitest";
import {
  extensionOf,
  innerCrumbs,
  keepExisting,
  sortEntries,
  summarize,
  type ViewEntry,
} from "../../src/frontend/archiveView";

const e = (
  name: string,
  type: ViewEntry["type"] = "file",
  size = 0,
  mtime = 0,
): ViewEntry => ({ name, type, size, mtime });

const sample = [
  e("b.txt", "file", 10, 3),
  e("a.log", "file", 300, 1),
  e("dir", "directory", 0, 2),
  e("c10.md", "file", 5, 5),
  e("c2.md", "file", 50, 4),
];

describe("sortEntries", () => {
  it("keeps folders first and sorts names naturally", () => {
    expect(sortEntries(sample, "name", "asc").map((x) => x.name)).toEqual([
      "dir",
      "a.log",
      "b.txt",
      "c2.md",
      "c10.md",
    ]);
  });
  it("reverses files but not the folder grouping", () => {
    expect(sortEntries(sample, "size", "desc").map((x) => x.name)).toEqual([
      "dir",
      "a.log",
      "c2.md",
      "b.txt",
      "c10.md",
    ]);
  });
  it("sorts by modified time and by type", () => {
    expect(sortEntries(sample, "modified", "asc").map((x) => x.name)).toEqual([
      "dir",
      "a.log",
      "b.txt",
      "c2.md",
      "c10.md",
    ]);
    expect(sortEntries(sample, "type", "asc").map((x) => x.name)).toEqual([
      "dir",
      "a.log",
      "c2.md",
      "c10.md",
      "b.txt",
    ]);
  });
});

describe("summarize", () => {
  it("counts items and sums file sizes", () => {
    expect(summarize(sample, new Set(["a.log", "dir", "gone"]))).toEqual({
      items: 5,
      selected: 2,
      totalSize: 365,
      selectedSize: 300,
    });
  });
});

describe("paths", () => {
  it("extracts extensions", () => {
    expect(extensionOf("a.TAR")).toBe("tar");
    expect(extensionOf(".bashrc")).toBe("");
    expect(extensionOf("x.")).toBe("");
  });
  it("builds breadcrumbs", () => {
    expect(innerCrumbs("/")).toEqual([]);
    expect(innerCrumbs("/a/b")).toEqual([
      { name: "a", path: "/a" },
      { name: "b", path: "/a/b" },
    ]);
  });
});

describe("keepExisting", () => {
  it("drops selected names that are gone after a reload", () => {
    const kept = keepExisting(new Set(["a", "b", "c"]), [
      { name: "a" },
      { name: "c" },
      { name: "d" },
    ]);
    expect([...kept].sort()).toEqual(["a", "c"]);
  });
  it("returns the same set when nothing changed, so state stays put", () => {
    const sel = new Set(["a"]);
    expect(keepExisting(sel, [{ name: "a" }, { name: "new" }])).toBe(sel);
    const empty = new Set<string>();
    expect(keepExisting(empty, [])).toBe(empty);
  });
});

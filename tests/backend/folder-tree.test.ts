import { describe, expect, it } from "vitest";
import {
  directoriesOnly,
  expansionChain,
  isWithin,
  mergeChildren,
} from "../../src/frontend/folderTree";
import type { FileItem } from "../../src/frontend/vendor/file-manager/host-types";

const item = (name: string, type: string, linkTarget?: string) =>
  ({ name, path: `/x/${name}`, type, linkTarget }) as unknown as FileItem;

describe("folder tree helpers", () => {
  it("builds the expansion chain", () => {
    expect(expansionChain("/")).toEqual(["/"]);
    expect(expansionChain("/a/b//c/")).toEqual(["/", "/a", "/a/b", "/a/b/c"]);
    expect(expansionChain("/папка/файл")).toEqual([
      "/",
      "/папка",
      "/папка/файл",
    ]);
  });

  it("keeps directories and links to directories only", () => {
    const dirs = directoriesOnly([
      item("a", "directory"),
      item("f.txt", "file"),
      item("broken", "link"),
      item("lnk", "directory", "/etc"),
    ]);
    expect(dirs.map((d) => d.name)).toEqual(["a", "lnk"]);
    expect(dirs[1].link).toBe(true);
    expect(dirs[0].link).toBe(false);
  });

  it("merges unique, sorted and capped", () => {
    const a = directoriesOnly([
      item("b", "directory"),
      item("10", "directory"),
    ]);
    const b = directoriesOnly([item("b", "directory"), item("2", "directory")]);
    const m = mergeChildren(a, b);
    expect(m.dirs.map((d) => d.name)).toEqual(["2", "10", "b"]);
    expect(m.more).toBe(false);
    const capped = mergeChildren(a, b, 2);
    expect(capped.dirs).toHaveLength(2);
    expect(capped.more).toBe(true);
  });

  it("tests containment", () => {
    expect(isWithin("/a/b", "/a")).toBe(true);
    expect(isWithin("/ab", "/a")).toBe(false);
    expect(isWithin("/a", "/")).toBe(true);
  });
});

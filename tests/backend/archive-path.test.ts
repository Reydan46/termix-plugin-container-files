import { describe, expect, it } from "vitest";
import {
  containingDirectory,
  isBrowsableArchive,
  isVirtualPath,
  parentPath,
  parseVirtualPath,
  virtualPath,
} from "../../src/frontend/archivePath";

describe("archive virtual paths", () => {
  it("recognises browsable archives", () => {
    for (const n of [
      "a.tar",
      "a.TGZ",
      "a.tar.gz",
      "a.tar.bz2",
      "a.tar.xz",
      "a.zip",
    ])
      expect(isBrowsableArchive(n), n).toBe(true);
    for (const n of ["a.gz", "a.7z", "a.txt", "tar"])
      expect(isBrowsableArchive(n), n).toBe(false);
  });

  it("builds and parses virtual paths", () => {
    expect(virtualPath("/d/a.tgz")).toBe("/d/a.tgz!");
    expect(virtualPath("/d/a.tgz", "/sub/x")).toBe("/d/a.tgz!/sub/x");
    expect(parseVirtualPath("/d/a.tgz!")).toEqual({
      archive: "/d/a.tgz",
      inner: "/",
    });
    expect(parseVirtualPath("/d/a.zip!/sub/")).toEqual({
      archive: "/d/a.zip",
      inner: "/sub",
    });
    expect(parseVirtualPath("/d/plain")).toBeNull();
    expect(isVirtualPath("/d/not!archive")).toBe(false);
  });

  it("walks up out of an archive", () => {
    expect(parentPath("/d/a.tgz!/sub/x")).toBe("/d/a.tgz!/sub");
    expect(parentPath("/d/a.tgz!/sub")).toBe("/d/a.tgz!");
    expect(parentPath("/d/a.tgz!")).toBe("/d");
    expect(parentPath("/a.tgz!")).toBe("/");
    expect(parentPath("/d/e")).toBe("/d");
    expect(containingDirectory("/d/a.tgz!/sub")).toBe("/d");
    expect(containingDirectory("/d")).toBe("/d");
  });
});

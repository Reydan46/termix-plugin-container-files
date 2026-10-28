import { describe, expect, it } from "vitest";
import { copyName } from "../../src/frontend/copyName";

describe("copyName", () => {
  const free = () => false;

  it("keeps the extension", () => {
    expect(copyName("a.txt", free)).toBe("a copy.txt");
    expect(copyName("a.tar.gz", free)).toBe("a copy.tar.gz");
    expect(copyName("my.file.js", free)).toBe("my.file copy.js");
  });

  it("handles names without an extension, dotfiles and folders", () => {
    expect(copyName("Makefile", free)).toBe("Makefile copy");
    expect(copyName(".env", free)).toBe(".env copy");
    expect(copyName("v1.2", free, true)).toBe("v1.2 copy");
  });

  it("numbers the copy when the name is taken", () => {
    const taken = new Set(["a copy.txt", "a copy 2.txt"]);
    expect(copyName("a.txt", (n) => taken.has(n))).toBe("a copy 3.txt");
  });
});

import { describe, expect, it } from "vitest";
import {
  afterPaste,
  cutDimCss,
  cutPaths,
  makeClipboard,
  pasteKind,
  resolvePasteTarget,
} from "../../src/frontend/workspace/clipboard";

const item = (path: string, isDirectory = false) => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  isDirectory,
});
const local = (mode: "copy" | "cut" = "copy") =>
  makeClipboard("L", null, [item("/a/x.txt"), item("/a/d", true)], mode)!;
const cont = (mode: "copy" | "cut" = "copy") =>
  makeClipboard("P1", "c1", [item("/etc/y")], mode)!;

describe("makeClipboard", () => {
  it("is null for no items and keeps origin otherwise", () => {
    expect(makeClipboard("L", null, [], "copy")).toBeNull();
    expect(local().containerId).toBeNull();
    expect(cont().paneId).toBe("P1");
  });
});

describe("pasteKind", () => {
  it("is none without a clipboard", () => {
    expect(pasteKind(null, { paneId: "P1", containerId: "c1" })).toBe("none");
  });
  it("local to container and back is a transfer", () => {
    expect(pasteKind(local(), { paneId: "P1", containerId: "c1" })).toBe(
      "transfer",
    );
    expect(pasteKind(cont(), { paneId: "L", containerId: null })).toBe(
      "transfer",
    );
  });
  it("container to another container pane is a transfer", () => {
    expect(pasteKind(cont(), { paneId: "P2", containerId: "c2" })).toBe(
      "transfer",
    );
  });
  it("same container pane stays with the pane's own clipboard", () => {
    expect(pasteKind(cont(), { paneId: "P1", containerId: "c1" })).toBe("own");
  });
  it("local to local is unsupported", () => {
    expect(pasteKind(local(), { paneId: "L", containerId: null })).toBe(
      "unsupported",
    );
    expect(pasteKind(local(), { paneId: "L2", containerId: null })).toBe(
      "unsupported",
    );
  });
});

describe("cutPaths", () => {
  it("dims only a cut, only in its own pane", () => {
    expect([...cutPaths(local("cut"), "L")]).toEqual(["/a/x.txt", "/a/d"]);
    expect(cutPaths(local("cut"), "P1").size).toBe(0);
    expect(cutPaths(local("copy"), "L").size).toBe(0);
    expect(cutPaths(null, "L").size).toBe(0);
  });
});

describe("afterPaste", () => {
  it("clears a cut only after success", () => {
    expect(afterPaste(local("cut"), true)).toBeNull();
    const failed = local("cut");
    expect(afterPaste(failed, false)).toBe(failed);
  });
  it("keeps a copy", () => {
    const c = local("copy");
    expect(afterPaste(c, true)).toBe(c);
  });
});

describe("resolvePasteTarget", () => {
  it("uses the single selected folder", () => {
    expect(resolvePasteTarget("/cur", [item("/cur/d", true)])).toBe("/cur/d");
  });
  it("uses the current folder otherwise", () => {
    expect(resolvePasteTarget("/cur", [])).toBe("/cur");
    expect(resolvePasteTarget("/cur", [item("/cur/f")])).toBe("/cur");
    expect(
      resolvePasteTarget("/cur", [item("/cur/a", true), item("/cur/b", true)]),
    ).toBe("/cur");
  });
});

describe("cutDimCss", () => {
  it("is empty without paths", () => {
    expect(cutDimCss("P1", new Set())).toBe("");
  });
  it("scopes the rule and escapes quotes and backslashes", () => {
    const css = cutDimCss("P1", new Set(['/a"b', "C:\\x"]));
    expect(css).toContain('[data-clip-scope="P1"]');
    expect(css).toContain('[data-file-path="/a\\"b"]');
    expect(css).toContain('[data-file-path="C:\\\\x"]');
    expect(css).toContain("opacity");
  });
});

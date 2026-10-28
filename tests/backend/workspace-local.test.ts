import { describe, expect, it } from "vitest";
import {
  emptyLayout,
  layoutReducer,
  parseLayout,
  serializeLayout,
  type Layout,
} from "../../src/frontend/workspace/layout";
import {
  localBaseName,
  parseLocalFiles,
} from "../../src/frontend/workspace/localPaths";

function withLocal(): Layout {
  let l = layoutReducer(emptyLayout(), { type: "add", containerId: "c1" });
  l = layoutReducer(l, { type: "addLocal" });
  return l;
}

describe("local pane layout", () => {
  it("adds one local pane and re-activates it instead of a second", () => {
    let l = withLocal();
    expect(l.panes.map((p) => p.kind)).toEqual(["container", "local"]);
    l = layoutReducer(l, { type: "activate", id: l.panes[0].id });
    l = layoutReducer(l, { type: "addLocal" });
    expect(l.panes).toHaveLength(2);
    expect(l.activeId).toBe(l.panes[1].id);
  });

  it("survives a serialize/parse round trip and prune", () => {
    const l = withLocal();
    const back = parseLayout(serializeLayout(l));
    expect(back.panes).toEqual(l.panes);
    const pruned = layoutReducer(back, {
      type: "prune",
      existing: new Set<string>(),
    });
    expect(pruned.panes.map((p) => p.kind)).toEqual(["local"]);
  });

  it("parse keeps at most one local pane", () => {
    const raw = JSON.stringify({
      panes: [
        { id: "pane-1", kind: "local" },
        { id: "pane-2", kind: "local" },
      ],
      tree: null,
      activeId: "pane-1",
      seq: 3,
    });
    expect(parseLayout(raw).panes).toHaveLength(1);
  });

  it("open and setContainer never turn the local pane into a container", () => {
    let l = layoutReducer(emptyLayout(), { type: "addLocal" });
    const opened = layoutReducer(l, { type: "open", containerId: "x" });
    expect(opened.panes.map((p) => p.kind)).toEqual(["local", "container"]);
    l = layoutReducer(l, {
      type: "setContainer",
      id: l.panes[0].id,
      containerId: "x",
    });
    expect(l.panes[0].kind).toBe("local");
  });
});

describe("local path helpers", () => {
  it("takes base names with either separator", () => {
    expect(localBaseName("C:\\Users\\me\\a.txt")).toBe("a.txt");
    expect(localBaseName("/home/me/dir/")).toBe("dir");
  });

  it("parses the local drag payload only", () => {
    expect(
      parseLocalFiles(
        JSON.stringify({ type: "local_files", paths: ["/a", 3] }),
      ),
    ).toEqual(["/a"]);
    expect(
      parseLocalFiles(
        JSON.stringify({ type: "internal_files", files: ["/a"] }),
      ),
    ).toEqual([]);
    expect(parseLocalFiles("nope")).toEqual([]);
  });
});

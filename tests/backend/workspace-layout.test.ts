import { describe, expect, it } from "vitest";
import {
  MAX_PANES,
  emptyLayout,
  layoutReducer,
  parseLayout,
  parsePaneState,
  serializeLayout,
  type Layout,
} from "../../src/frontend/workspace/layout";

function add(layout: Layout, containerId: string | null) {
  return layoutReducer(layout, { type: "add", containerId });
}

describe("layoutReducer", () => {
  it("adds panes up to the maximum", () => {
    let l = emptyLayout();
    for (let i = 0; i < MAX_PANES + 2; i++) l = add(l, `c${i}`);
    expect(l.panes).toHaveLength(MAX_PANES);
    expect(l.activeId).toBe(l.panes[MAX_PANES - 1].id);
  });

  it("open activates an existing pane for the container", () => {
    let l = add(add(emptyLayout(), "a"), "b");
    l = layoutReducer(l, { type: "open", containerId: "a" });
    expect(l.panes).toHaveLength(2);
    expect(l.activeId).toBe(l.panes[0].id);
  });

  it("open replaces the active pane when full", () => {
    let l = emptyLayout();
    for (const c of ["a", "b", "c", "d"]) l = add(l, c);
    l = layoutReducer(l, { type: "open", containerId: "z" });
    expect(l.panes.map((p) => p.containerId)).toEqual(["a", "b", "c", "z"]);
  });

  it("close moves the active pane to a neighbour", () => {
    let l = add(add(add(emptyLayout(), "a"), "b"), "c");
    l = layoutReducer(l, { type: "close", id: l.panes[2].id });
    expect(l.activeId).toBe(l.panes[1].id);
    l = layoutReducer(l, { type: "close", id: l.panes[0].id });
    l = layoutReducer(l, { type: "close", id: l.panes[0].id });
    expect(l.panes).toHaveLength(0);
    expect(l.activeId).toBeNull();
  });

  it("never reuses ids", () => {
    let l = add(emptyLayout(), "a");
    const first = l.panes[0].id;
    l = layoutReducer(l, { type: "close", id: first });
    l = add(l, "a");
    expect(l.panes[0].id).not.toBe(first);
  });

  it("prunes panes of removed containers but keeps pickers", () => {
    let l = add(add(add(emptyLayout(), "a"), "b"), null);
    l = layoutReducer(l, { type: "prune", existing: new Set(["b"]) });
    expect(l.panes.map((p) => p.containerId)).toEqual(["b", null]);
  });

  it("setContainer and activate", () => {
    let l = add(add(emptyLayout(), null), "b");
    l = layoutReducer(l, {
      type: "setContainer",
      id: l.panes[0].id,
      containerId: "x",
    });
    expect(l.panes[0].containerId).toBe("x");
    l = layoutReducer(l, { type: "activate", id: l.panes[0].id });
    expect(l.activeId).toBe(l.panes[0].id);
    expect(layoutReducer(l, { type: "activate", id: "nope" })).toBe(l);
  });
});

describe("layout persistence", () => {
  it("round-trips", () => {
    const l = add(add(emptyLayout(), "a"), null);
    expect(parseLayout(serializeLayout(l))).toEqual(l);
  });

  it("tolerates garbage", () => {
    expect(parseLayout(null)).toEqual(emptyLayout());
    expect(parseLayout("{nope")).toEqual(emptyLayout());
    expect(parseLayout('{"panes":5}')).toEqual(emptyLayout());
  });

  it("drops bad and duplicate panes, caps the count, fixes seq", () => {
    const raw = JSON.stringify({
      panes: [
        { id: "pane-1", kind: "container", containerId: "a" },
        { id: "pane-1", kind: "container", containerId: "b" },
        { id: "x", kind: "other", containerId: "c" },
        { id: "pane-7", kind: "container", containerId: 5 },
        { id: "pane-2", kind: "container", containerId: null },
        { id: "pane-3", kind: "container", containerId: "d" },
        { id: "pane-4", kind: "container", containerId: "e" },
        { id: "pane-5", kind: "container", containerId: "f" },
      ],
      activeId: "missing",
      seq: 1,
    });
    const l = parseLayout(raw);
    expect(l.panes.map((p) => p.id)).toEqual([
      "pane-1",
      "pane-2",
      "pane-3",
      "pane-4",
    ]);
    expect(l.activeId).toBe("pane-1");
    expect(l.seq).toBe(5);
  });

  it("parses pane view state defensively", () => {
    expect(parsePaneState(null)).toEqual({});
    expect(
      parsePaneState(
        '{"path":"/etc","viewMode":"grid","sortBy":"bad","sortOrder":"desc"}',
      ),
    ).toEqual({ viewMode: "grid", sortOrder: "desc" });
    // The folder is never restored: containers always open at "/".
    expect(parsePaneState('{"path":"/etc"}')).toEqual({});
  });
});

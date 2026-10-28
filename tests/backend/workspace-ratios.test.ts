import { describe, expect, it } from "vitest";
import {
  MIN_RATIO,
  computeRects,
  computeSplitters,
  emptyLayout,
  layoutReducer,
  parseLayout,
  serializeLayout,
  type Layout,
} from "../../src/frontend/workspace/layout";

function two(): Layout {
  let l = emptyLayout();
  l = layoutReducer(l, { type: "add", containerId: "a" });
  return layoutReducer(l, { type: "add", containerId: "b" });
}

describe("split ratios", () => {
  it("defaults to equal shares and lists one splitter", () => {
    const l = two();
    const rects = computeRects(l.tree);
    expect(rects.get("pane-1")?.w).toBeCloseTo(0.5);
    const s = computeSplitters(l.tree);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ path: [], index: 0, dir: "row", offset: 0.5 });
  });

  it("resizes by boundary position and clamps to the minimum", () => {
    let l = layoutReducer(two(), {
      type: "resize",
      path: [],
      index: 0,
      position: 0.3,
    });
    expect(computeRects(l.tree).get("pane-1")?.w).toBeCloseTo(0.3);
    expect(computeRects(l.tree).get("pane-2")?.x).toBeCloseTo(0.3);
    l = layoutReducer(l, {
      type: "resize",
      path: [],
      index: 0,
      position: 0.01,
    });
    expect(computeRects(l.tree).get("pane-1")?.w).toBeCloseTo(MIN_RATIO);
    l = layoutReducer(l, { type: "resize", path: [], index: 0, position: 5 });
    expect(computeRects(l.tree).get("pane-2")?.w).toBeCloseTo(MIN_RATIO);
  });

  it("ignores bad paths, indexes and positions", () => {
    const l = two();
    expect(
      layoutReducer(l, { type: "resize", path: [7], index: 0, position: 0.3 })
        .tree,
    ).toEqual(l.tree);
    expect(
      layoutReducer(l, { type: "resize", path: [], index: 3, position: 0.3 })
        .tree,
    ).toEqual(l.tree);
    expect(
      layoutReducer(l, { type: "resize", path: [], index: 0, position: NaN })
        .tree,
    ).toEqual(l.tree);
  });

  it("resizes a nested split inside its own rectangle", () => {
    let l = two();
    l = layoutReducer(l, { type: "add", containerId: "c" }); // col(row(1,2), 3)
    const nested = computeSplitters(l.tree).find((s) => s.path.length === 0);
    expect(nested?.dir).toBe("col");
    l = layoutReducer(l, {
      type: "resize",
      path: [0],
      index: 0,
      position: 0.25,
    });
    const r = computeRects(l.tree);
    expect(r.get("pane-1")?.w).toBeCloseTo(0.25);
    expect(r.get("pane-2")?.w).toBeCloseTo(0.75);
    expect(r.get("pane-3")?.w).toBeCloseTo(1);
  });

  it("double-click reset restores equal shares", () => {
    let l = layoutReducer(two(), {
      type: "resize",
      path: [],
      index: 0,
      position: 0.3,
    });
    l = layoutReducer(l, { type: "resetRatios", path: [] });
    expect(computeRects(l.tree).get("pane-1")?.w).toBeCloseTo(0.5);
  });

  it("resets the affected split when a pane is added or closed", () => {
    let l = layoutReducer(two(), {
      type: "resize",
      path: [],
      index: 0,
      position: 0.3,
    });
    const closed = layoutReducer(l, { type: "close", id: "pane-2" });
    expect(computeRects(closed.tree).get("pane-1")?.w).toBeCloseTo(1);
    l = layoutReducer(l, { type: "add", containerId: "c" });
    // the row stays a 2-child split nested in a column: its ratios survive
    expect(computeRects(l.tree).get("pane-1")?.w).toBeCloseTo(0.3);
    l = layoutReducer(l, { type: "add", containerId: "d" });
    expect(computeRects(l.tree).get("pane-1")?.w).toBeCloseTo(0.3);
  });

  it("drops ratios of a split that gains a child", () => {
    let l = layoutReducer(emptyLayout(), { type: "add", containerId: "a" });
    l = layoutReducer(l, { type: "add", containerId: "b" });
    l = layoutReducer(l, { type: "dock", id: "pane-2", zone: "left" });
    l = layoutReducer(l, { type: "resize", path: [], index: 0, position: 0.3 });
    l = layoutReducer(l, { type: "close", id: "pane-1" });
    expect(computeRects(l.tree).get("pane-2")?.w).toBeCloseTo(1);
  });

  it("survives a serialize/parse round trip and rejects bad ratios", () => {
    const l = layoutReducer(two(), {
      type: "resize",
      path: [],
      index: 0,
      position: 0.3,
    });
    const back = parseLayout(serializeLayout(l));
    expect(computeRects(back.tree).get("pane-1")?.w).toBeCloseTo(0.3);
    const raw = JSON.parse(serializeLayout(l));
    raw.tree.ratios = [0.9, 0.9];
    const bad = parseLayout(JSON.stringify(raw));
    expect(computeRects(bad.tree).get("pane-1")?.w).toBeCloseTo(0.5);
  });
});

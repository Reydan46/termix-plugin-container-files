import { describe, expect, it } from "vitest";
import {
  applyDrop,
  computeRects,
  dropPreview,
  emptyIds,
  isValidTree,
  treeIds,
  type Layout,
  type LayoutNode,
} from "../../src/frontend/workspace/layout";

describe("moving into free space keeps the other panes in place", () => {
  const p = (id: string): LayoutNode => ({ type: "pane", id });
  const e = (id: string): LayoutNode => ({ type: "empty", id });
  const mk = (tree: LayoutNode, ids: string[]): Layout => ({
    panes: ids.map((id) => ({ id, kind: "container", containerId: id })),
    tree,
    activeId: ids[0],
    seq: 10,
  });
  const same = (a: Layout, b: Layout, ids: string[]) => {
    const ra = computeRects(a.tree);
    const rb = computeRects(b.tree);
    for (const i of ids) {
      const x = ra.get(i)!;
      const y = rb.get(i)!;
      expect(y.x).toBeCloseTo(x.x, 9);
      expect(y.y).toBeCloseTo(x.y, 9);
      expect(y.w).toBeCloseTo(x.w, 9);
      expect(y.h).toBeCloseTo(x.h, 9);
    }
  };

  it("bottomRight quarter of the right pane leaves the left pane alone", () => {
    const l = mk(
      {
        type: "split",
        dir: "row",
        ratios: [0.5, 0.5],
        children: [p("a"), p("b")],
      },
      ["a", "b"],
    );
    const t = { kind: "zone", zone: "bottomRight" } as const;
    const next = applyDrop(l, "b", t);
    same(l, next, ["a"]);
    expect(isValidTree(next.tree)).toBe(true);
    expect(emptyIds(next.tree)).toHaveLength(1);
    const r = computeRects(next.tree).get("b")!;
    expect(r.x).toBeCloseTo(0.5);
    expect(r.y).toBeCloseTo(0.5);
    expect(dropPreview(l, "b", t).rects).toEqual([r]);
  });

  it("diagonal panes: moving into empty areas keeps the other pane", () => {
    const tree: LayoutNode = {
      type: "split",
      dir: "col",
      children: [
        { type: "split", dir: "row", children: [p("a"), e("e1")] },
        { type: "split", dir: "row", children: [e("e2"), p("b")] },
      ],
    };
    const l = mk(tree, ["a", "b"]);
    for (const zone of ["topRight", "right", "bottom", "bottomLeft"] as const) {
      const next = applyDrop(l, "b", { kind: "zone", zone });
      same(l, next, ["a"]);
      expect(isValidTree(next.tree)).toBe(true);
      expect(treeIds(next.tree).sort()).toEqual(["a", "b"]);
    }
  });

  it("a zone overlapping another pane docks the old way", () => {
    const l = mk({ type: "split", dir: "row", children: [p("a"), p("b")] }, [
      "a",
      "b",
    ]);
    const next = applyDrop(l, "b", { kind: "zone", zone: "left" });
    const r = computeRects(next.tree);
    expect(r.get("b")).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(r.get("a")).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });
});

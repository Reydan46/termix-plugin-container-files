import { describe, expect, it } from "vitest";
import {
  absorbArea,
  absorbEmpty,
  absorbTarget,
  closeEmptySlot,
  computeRects,
  computeSplitters,
  emptyIds,
  isValidTree,
  layoutReducer,
  treeIds,
  type Layout,
  type LayoutNode,
} from "../../src/frontend/workspace/layout";

const p = (id: string): LayoutNode => ({ type: "pane", id });
const e = (id: string): LayoutNode => ({ type: "empty", id });
const row = (...children: LayoutNode[]): LayoutNode => ({
  type: "split",
  dir: "row",
  children,
});
const col = (...children: LayoutNode[]): LayoutNode => ({
  type: "split",
  dir: "col",
  children,
});

function layoutOf(tree: LayoutNode): Layout {
  return {
    panes: treeIds(tree).map((id) => ({
      id,
      kind: "container" as const,
      containerId: id,
    })),
    tree,
    activeId: treeIds(tree)[0] ?? null,
    seq: 20,
  };
}

describe("closeEmptySlot", () => {
  it("the only sibling: the parent collapses into the pane", () => {
    expect(closeEmptySlot(row(p("a"), e("e1")), "e1")).toEqual(p("a"));
    expect(closeEmptySlot(col(e("e1"), p("a")), "e1")).toEqual(p("a"));
  });

  it("the neighbour pane grows into the freed space", () => {
    const tree = col(row(p("a"), e("e1")), p("b"));
    const next = closeEmptySlot(tree, "e1")!;
    const r = computeRects(next);
    expect(r.get("a")).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(r.get("b")).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
    expect(emptyIds(next)).toEqual([]);
    expect(isValidTree(next)).toBe(true);
  });

  it("a neighbour subtree grows as a whole", () => {
    const tree = row(e("e1"), col(p("a"), p("b")));
    const next = closeEmptySlot(tree, "e1")!;
    const r = computeRects(next);
    expect(r.get("a")).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(r.get("b")).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });

  it("with more siblings the freed share goes to the previous one", () => {
    const tree: LayoutNode = {
      ...(row(p("a"), e("e1"), p("b")) as Extract<
        LayoutNode,
        { type: "split" }
      >),
      ratios: [0.5, 0.2, 0.3],
    };
    const r = computeRects(closeEmptySlot(tree, "e1"));
    expect(r.get("a")!.w).toBeCloseTo(0.7);
    expect(r.get("b")!.w).toBeCloseTo(0.3);
    expect(r.get("b")!.x).toBeCloseTo(0.7);
  });

  it("at the start the next sibling takes the space", () => {
    const tree = row(e("e1"), p("a"), p("b"));
    const r = computeRects(closeEmptySlot(tree, "e1"));
    expect(r.get("a")!.w).toBeCloseTo(2 / 3);
    expect(r.get("b")!.w).toBeCloseTo(1 / 3);
  });

  it("collapsing a nested split keeps the rest intact", () => {
    // [a | [e1 / e2]]: closing e1 leaves [a | e2]
    const tree = row(p("a"), col(e("e1"), e("e2")));
    const next = closeEmptySlot(tree, "e1")!;
    expect(emptyIds(next)).toEqual(["e2"]);
    expect(treeIds(next)).toEqual(["a"]);
    expect(computeRects(next).get("e2")).toEqual({
      x: 0.5,
      y: 0,
      w: 0.5,
      h: 1,
    });
  });

  it("ignores unknown ids and trees without that slot", () => {
    const tree = row(p("a"), e("e1"));
    expect(closeEmptySlot(tree, "nope")).toBe(tree);
    expect(closeEmptySlot(null, "e1")).toBeNull();
    expect(closeEmptySlot(p("a"), "a")).toEqual(p("a"));
  });

  it("the reducer closes the slot and keeps every pane", () => {
    const l = layoutOf(col(row(p("a"), e("e1")), row(e("e2"), p("b"))));
    const next = layoutReducer(l, { type: "closeEmpty", id: "e1" });
    expect(emptyIds(next.tree)).toEqual(["e2"]);
    expect(next.panes).toEqual(l.panes);
    expect(computeRects(next.tree).get("a")).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 0.5,
    });
    expect(isValidTree(next.tree)).toBe(true);
  });
});

describe("splitter dragged toward an empty slot", () => {
  it("highlights once the empty side drops below a quarter", () => {
    const tree = row(p("a"), e("e1"));
    expect(absorbTarget(tree, [], 0, 0.5)).toBeNull();
    expect(absorbTarget(tree, [], 0, 0.74)).toBeNull();
    expect(absorbTarget(tree, [], 0, 0.76)).toBe("e1");
    expect(absorbTarget(tree, [], 0, 1.2)).toBe("e1");
  });

  it("works when the empty slot is before the splitter", () => {
    const tree = col(e("e1"), p("a"));
    expect(absorbTarget(tree, [], 0, 0.3)).toBeNull();
    expect(absorbTarget(tree, [], 0, 0.2)).toBe("e1");
    expect(absorbTarget(tree, [], 0, -0.1)).toBe("e1");
  });

  it("dragging back out of the threshold clears the target", () => {
    const tree = row(p("a"), e("e1"));
    expect(absorbTarget(tree, [], 0, 0.9)).toBe("e1");
    expect(absorbTarget(tree, [], 0, 0.6)).toBeNull();
  });

  it("needs a pane (or subtree) on one side and an empty slot on the other", () => {
    expect(absorbTarget(row(p("a"), p("b")), [], 0, 0.95)).toBeNull();
    expect(absorbTarget(row(e("e1"), e("e2")), [], 0, 0.95)).toBeNull();
    expect(absorbTarget(row(p("a"), e("e1")), [], 1, 0.95)).toBeNull();
    expect(absorbTarget(row(p("a"), e("e1")), [3], 0, 0.95)).toBeNull();
    expect(absorbTarget(null, [], 0, 0.95)).toBeNull();
    expect(absorbTarget(row(p("a"), e("e1")), [], 0, NaN)).toBeNull();
  });

  it("measures the share inside nested splits and with several children", () => {
    const nested = col(row(p("a"), e("e1")), p("b"));
    expect(absorbTarget(nested, [0], 0, 0.8)).toBe("e1");
    expect(absorbTarget(nested, [0], 0, 0.6)).toBeNull();
    // [a | b | e1] with equal thirds: e1 starts at 2/3, share 1/3
    const three = row(p("a"), p("b"), e("e1"));
    expect(absorbTarget(three, [], 1, 0.7)).toBeNull();
    expect(absorbTarget(three, [], 1, 0.8)).toBe("e1");
  });

  it("a small pair does not absorb right at the start of a drag", () => {
    const tree: LayoutNode = {
      type: "split",
      dir: "row",
      children: [p("a"), p("b"), e("e1")],
      ratios: [0.7, 0.15, 0.15],
    };
    // pair 0.3: the slot starts at share 0.15, below a quarter already
    expect(absorbTarget(tree, [], 1, 0.85)).toBeNull();
    expect(absorbTarget(tree, [], 1, 0.95)).toBe("e1");
  });

  it("releasing past the threshold: the pane takes both areas", () => {
    const l = layoutOf(row(p("a"), e("e1")));
    const next = layoutReducer(l, { type: "absorb", path: [], index: 0 });
    expect(next.tree).toEqual(p("a"));
    expect(next.panes).toEqual(l.panes);
    const before = layoutOf(row(e("e1"), p("a")));
    expect(
      layoutReducer(before, { type: "absorb", path: [], index: 0 }).tree,
    ).toEqual(p("a"));
  });

  it("the pane next to the splitter grows, the rest keeps its size", () => {
    const l = layoutOf({
      type: "split",
      dir: "row",
      children: [p("a"), p("b"), e("e1")],
      ratios: [0.5, 0.2, 0.3],
    });
    const next = layoutReducer(l, { type: "absorb", path: [], index: 1 });
    const r = computeRects(next.tree);
    expect(r.get("a")).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(r.get("b")!.x).toBeCloseTo(0.5);
    expect(r.get("b")!.w).toBeCloseTo(0.5);
    expect(emptyIds(next.tree)).toEqual([]);
  });

  it("a nested split collapses and the subtree beside it expands", () => {
    const l = layoutOf(col(row(p("a"), e("e1")), p("b")));
    const next = layoutReducer(l, { type: "absorb", path: [0], index: 0 });
    const r = computeRects(next.tree);
    expect(r.get("a")).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(r.get("b")).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
    expect(isValidTree(next.tree)).toBe(true);
  });

  it("does nothing between two panes or for a stale path", () => {
    const l = layoutOf(row(p("a"), p("b")));
    expect(
      layoutReducer(l, { type: "absorb", path: [], index: 0 }).tree,
    ).toEqual(l.tree);
    expect(
      layoutReducer(l, { type: "absorb", path: [4], index: 0 }).tree,
    ).toEqual(l.tree);
    expect(absorbEmpty(null, [], 0)).toBeNull();
  });
});

describe("absorb highlight", () => {
  it("covers the pane area plus the empty area, not only the empty part", () => {
    // a takes 70%, the slot 30%: the highlight is the whole split
    const tree: LayoutNode = {
      ...(row(p("a"), e("e1")) as Extract<LayoutNode, { type: "split" }>),
      ratios: [0.7, 0.3],
    };
    expect(absorbArea(tree, [], 0)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("is the pair of children inside a nested split", () => {
    const tree = col(row(e("e1"), p("a")), p("b"));
    const area = absorbArea(tree, [0], 0)!;
    expect(area).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
  });

  it("does not move while the splitter is dragged", () => {
    const tree = col(p("a"), e("e1"));
    const before = absorbArea(tree, [], 0);
    const moved = layoutOf(tree);
    const dragged = layoutReducer(moved, {
      type: "resize",
      path: [],
      index: 0,
      position: 0.8,
    });
    expect(absorbArea(dragged.tree, [], 0)).toEqual(before);
  });

  it("is exactly the rectangle the pane gets after absorbing", () => {
    const trees = [
      row(p("a"), e("e1")),
      col(e("e1"), p("a")),
      col(row(p("a"), e("e1")), p("b")),
      row(col(p("a"), p("b")), col(e("e1"), p("c"))),
    ];
    for (const tree of trees) {
      const l = layoutOf(tree);
      const splitters = computeSplitters(tree);
      for (const s of splitters) {
        const area = absorbArea(tree, s.path, s.index);
        if (!area) continue;
        const next = absorbEmpty(tree, s.path, s.index)!;
        const rects = computeRects(next);
        const grown = [...rects.values()].filter(
          (r) =>
            Math.abs(r.x - area.x) < 1e-9 &&
            Math.abs(r.y - area.y) < 1e-9 &&
            Math.abs(r.w - area.w) < 1e-9 &&
            Math.abs(r.h - area.h) < 1e-9,
        );
        expect(grown.length, JSON.stringify(tree)).toBe(1);
        expect(l.panes.length).toBe(treeIds(next).length);
      }
    }
  });

  it("is null without an empty slot beside the splitter", () => {
    expect(absorbArea(row(p("a"), p("b")), [], 0)).toBeNull();
    expect(absorbArea(null, [], 0)).toBeNull();
  });
});

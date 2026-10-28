import { describe, expect, it } from "vitest";
import {
  applyDrop,
  computeRects,
  dropPreview,
  emptyIds,
  emptyLayout,
  isValidTree,
  layoutReducer,
  resolveDrop,
  treeIds,
  type DropTarget,
  type Layout,
  type LayoutNode,
} from "../../src/frontend/workspace/layout";
import { decideDragEnd } from "../../src/frontend/workspace/paneDrag";

function grid(n: number): Layout {
  let l = emptyLayout();
  for (let i = 0; i < n; i++)
    l = layoutReducer(l, { type: "add", containerId: `c${i}` });
  return l;
}

const zones = [
  "left",
  "right",
  "top",
  "bottom",
  "topLeft",
  "topRight",
  "bottomLeft",
  "bottomRight",
] as const;

describe("pane drag respects valid layouts", () => {
  it("detects three tiles in a row or column", () => {
    const p = (id: string): LayoutNode => ({ type: "pane", id });
    const row = (...children: LayoutNode[]): LayoutNode => ({
      type: "split",
      dir: "row",
      children,
    });
    expect(isValidTree(row(p("a"), row(p("b"), p("c"))))).toBe(false);
    expect(isValidTree(row(p("a"), p("b"), p("c")))).toBe(false);
    expect(
      isValidTree({
        type: "split",
        dir: "col",
        children: [row(p("a"), p("b")), p("c")],
      }),
    ).toBe(true);
  });

  it("no dock zone ever produces three in a row, for 1..4 panes", () => {
    for (const n of [1, 2, 3, 4]) {
      for (const zone of zones) {
        for (let k = 0; k < n; k++) {
          const l0 = grid(n);
          const l = layoutReducer(l0, {
            type: "dock",
            id: l0.panes[k].id,
            zone,
          });
          expect(isValidTree(l.tree), `${n} panes, ${zone}`).toBe(true);
          expect(treeIds(l.tree).sort()).toEqual(
            l.panes.map((p) => p.id).sort(),
          );
        }
      }
    }
  });

  it("an edge dock with 3 panes stacks the other two in the other half", () => {
    const l0 = grid(3);
    const id = l0.panes[2].id;
    const l = layoutReducer(l0, { type: "dock", id, zone: "right" });
    const r = computeRects(l.tree);
    expect(r.get(id)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    for (const p of l.panes.filter((q) => q.id !== id)) {
      const q = r.get(p.id)!;
      expect([q.x, q.w, q.h]).toEqual([0, 0.5, 0.5]);
    }
  });

  it("with 4 panes a dock swaps into the 2x2 cell", () => {
    const l0 = grid(4);
    const [a, , , d] = l0.panes.map((p) => p.id);
    const l = layoutReducer(l0, { type: "dock", id: d, zone: "topLeft" });
    const r = computeRects(l.tree);
    expect(r.get(d)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(r.get(a)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it("swap exchanges two panes and keeps the ratios", () => {
    let l = grid(2);
    l = layoutReducer(l, { type: "resize", path: [], index: 0, position: 0.3 });
    const [a, b] = l.panes.map((p) => p.id);
    const s = layoutReducer(l, { type: "swap", id: b, withId: a });
    const r = computeRects(s.tree);
    expect(r.get(b)!.x).toBe(0);
    expect(r.get(b)!.w).toBeCloseTo(0.3);
    expect(r.get(a)!.x).toBeCloseTo(0.3);
    expect(s.activeId).toBe(b);
    expect(layoutReducer(s, { type: "swap", id: b, withId: "nope" })).toBe(s);
  });

  // a top-left, b bottom-right, the other two quarters empty
  const diagonal = (): Layout => ({
    panes: [
      { id: "a", kind: "container", containerId: "c1" },
      { id: "b", kind: "container", containerId: "c2" },
    ],
    tree: {
      type: "split",
      dir: "col",
      children: [
        {
          type: "split",
          dir: "row",
          children: [
            { type: "pane", id: "a" },
            { type: "empty", id: "e1" },
          ],
        },
        {
          type: "split",
          dir: "row",
          children: [
            { type: "empty", id: "e2" },
            { type: "pane", id: "b" },
          ],
        },
      ],
    },
    activeId: "b",
    seq: 10,
  });

  it("diagonal: the pane body swaps, an empty quarter moves", () => {
    const l = diagonal();
    const onA = resolveDrop(l, "b", 0.25, 0.25);
    expect(onA).toEqual({ kind: "swap", withId: "a" });
    const swapped = applyDrop(l, "b", onA!);
    expect(computeRects(swapped.tree).get("b")).toEqual({
      x: 0,
      y: 0,
      w: 0.5,
      h: 0.5,
    });
    expect(computeRects(swapped.tree).get("a")).toEqual({
      x: 0.5,
      y: 0.5,
      w: 0.5,
      h: 0.5,
    });
    const onSlot = resolveDrop(l, "b", 0.75, 0.25);
    expect(onSlot).toEqual({ kind: "slot", withId: "e1" });
    const moved = applyDrop(l, "b", onSlot!);
    expect(computeRects(moved.tree).get("b")).toEqual({
      x: 0.5,
      y: 0,
      w: 0.5,
      h: 0.5,
    });
    expect(emptyIds(moved.tree).sort()).toEqual(["e1", "e2"]);
    expect(treeIds(moved.tree).sort()).toEqual(["a", "b"]);
    expect(isValidTree(moved.tree)).toBe(true);
  });

  it("over its own body nothing happens; edges dock to a zone", () => {
    const l = grid(2);
    const [a] = l.panes.map((p) => p.id);
    expect(resolveDrop(l, a, 0.25, 0.5)).toBeNull();
    expect(resolveDrop(l, a, 0.75, 0.5)).toEqual({
      kind: "swap",
      withId: l.panes[1].id,
    });
    expect(resolveDrop(l, a, 0.02, 0.5)).toEqual({
      kind: "zone",
      zone: "left",
    });
    expect(resolveDrop(grid(4), "pane-1", 0.02, 0.2)).toEqual({
      kind: "zone",
      zone: "topLeft",
    });
  });

  it("previews a swap with only the dragged pane's new tile", () => {
    const l = grid(2);
    const p = dropPreview(l, l.panes[0].id, {
      kind: "swap",
      withId: l.panes[1].id,
    });
    expect(p.swap).toBe(true);
    expect(p.rects).toHaveLength(1);
  });
});

describe("a lone pane dragged over the workspace", () => {
  const full = { x: 0, y: 0, w: 1, h: 1 };

  it("pointer inside: the normal dock zones apply", () => {
    const l = grid(1);
    const id = l.panes[0].id;
    const cases: [number, number, string, object][] = [
      [0.02, 0.5, "left", { x: 0, y: 0, w: 0.5, h: 1 }],
      [0.98, 0.5, "right", { x: 0.5, y: 0, w: 0.5, h: 1 }],
      [0.5, 0.02, "top", { x: 0, y: 0, w: 1, h: 0.5 }],
      [0.5, 0.98, "bottom", { x: 0, y: 0.5, w: 1, h: 0.5 }],
      [0.02, 0.02, "topLeft", { x: 0, y: 0, w: 0.5, h: 0.5 }],
      [0.98, 0.98, "bottomRight", { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }],
      [0.3, 0.5, "left", { x: 0, y: 0, w: 0.5, h: 1 }],
      [0.2, 0.2, "topLeft", { x: 0, y: 0, w: 0.5, h: 0.5 }],
    ];
    for (const [fx, fy, zone, rect] of cases) {
      const t = resolveDrop(l, id, fx, fy)!;
      expect(t, `${fx},${fy}`).toEqual({ kind: "zone", zone });
      expect(dropPreview(l, id, t)).toEqual({ swap: false, rects: [rect] });
      const next = applyDrop(l, id, t);
      expect(computeRects(next.tree).get(id)).toEqual(rect);
      expect(next.panes).toEqual(l.panes);
      expect(treeIds(next.tree)).toEqual([id]);
      expect(emptyIds(next.tree).length).toBeGreaterThan(0);
      expect(isValidTree(next.tree)).toBe(true);
    }
  });

  it("a half layout lets the pane move into an empty cell", () => {
    const l0 = grid(1);
    const id = l0.panes[0].id;
    const half = applyDrop(l0, id, { kind: "zone", zone: "topLeft" });
    const slot = emptyIds(half.tree).find(
      (e) => computeRects(half.tree).get(e)!.x === 0.5,
    )!;
    const t = resolveDrop(half, id, 0.75, 0.25)!;
    expect(t).toEqual({ kind: "slot", withId: slot });
    expect(computeRects(applyDrop(half, id, t).tree).get(id)).toEqual({
      x: 0.5,
      y: 0,
      w: 0.5,
      h: 0.5,
    });
  });

  it("pointer outside the workspace fills it with the single pane", () => {
    const l = grid(1);
    const id = l.panes[0].id;
    for (const [fx, fy] of [
      [-0.01, 0.5],
      [1.01, 0.5],
      [0.5, -0.02],
      [0.5, 1.02],
      [-0.1, -0.1],
    ]) {
      const t = resolveDrop(l, id, fx, fy)!;
      expect(t).toEqual({ kind: "fill" });
      expect(dropPreview(l, id, t)).toEqual({ swap: false, rects: [full] });
      const next = applyDrop(l, id, t);
      expect(next.tree).toEqual({ type: "pane", id });
      expect(next.panes).toEqual(l.panes);
      expect(computeRects(next.tree).get(id)).toEqual(full);
      expect(isValidTree(next.tree)).toBe(true);
    }
  });

  it("outside also resets a half layout back to one full pane", () => {
    const l0 = grid(1);
    const id = l0.panes[0].id;
    const half = applyDrop(l0, id, { kind: "zone", zone: "left" });
    expect(emptyIds(half.tree)).toHaveLength(1);
    const t = resolveDrop(half, id, 1.05, 0.5)!;
    expect(t).toEqual({ kind: "fill" });
    const next = applyDrop(half, id, t);
    expect(next.tree).toEqual({ type: "pane", id });
    expect(emptyIds(next.tree)).toEqual([]);
  });

  it("with several panes the outside means nothing", () => {
    const l = grid(2);
    expect(resolveDrop(l, l.panes[0].id, -0.05, 0.5)).toBeNull();
    expect(resolveDrop(l, l.panes[0].id, 0.5, 1.05)).toBeNull();
  });

  it("repairs a lone pane left inside a split with an empty slot", () => {
    const l = grid(1);
    const id = l.panes[0].id;
    const odd: Layout = {
      ...l,
      tree: {
        type: "split",
        dir: "row",
        children: [
          { type: "pane", id },
          { type: "empty", id: "e1" },
        ],
      },
    };
    expect(applyDrop(odd, id, { kind: "fill" }).tree).toEqual({
      type: "pane",
      id,
    });
  });

  it("two panes still dock to zones", () => {
    const l = grid(2);
    expect(resolveDrop(l, l.panes[0].id, 0.02, 0.5)).toEqual({
      kind: "zone",
      zone: "left",
    });
  });
});

describe("releasing a pane drag outside every drop target", () => {
  const fill: DropTarget = { kind: "fill" };
  const zone: DropTarget = { kind: "zone", zone: "left" };
  const idle = { handled: false, cancelled: false };

  it("applies the fill the preview was showing", () => {
    expect(decideDragEnd({ ...idle, last: fill })).toEqual(fill);
  });

  it("applies nothing when no preview was showing", () => {
    expect(decideDragEnd({ ...idle, last: null })).toBeNull();
  });

  it("only the fill is applied from dragend, other targets come with drop", () => {
    expect(decideDragEnd({ ...idle, last: zone })).toBeNull();
    expect(
      decideDragEnd({ ...idle, last: { kind: "swap", withId: "x" } }),
    ).toBeNull();
  });

  it("Escape cancels even with the fill showing", () => {
    expect(
      decideDragEnd({ handled: false, cancelled: true, last: fill }),
    ).toBeNull();
  });

  it("a drop that already applied the pane is not applied twice", () => {
    expect(
      decideDragEnd({ handled: true, cancelled: false, last: fill }),
    ).toBeNull();
  });

  it("a lone pane in any position ends as one full-size pane", () => {
    for (const z of zones) {
      const l0 = grid(1);
      const id = l0.panes[0].id;
      const placed = applyDrop(l0, id, { kind: "zone", zone: z });
      // pointer left the workspace: the preview resolved to the fill
      const last = resolveDrop(placed, id, 1.2, 0.4);
      const target = decideDragEnd({ ...idle, last });
      expect(target, z).toEqual(fill);
      const next = applyDrop(placed, id, target!);
      expect(next.tree).toEqual({ type: "pane", id });
      expect(computeRects(next.tree).get(id)).toEqual({
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      });
    }
  });

  it("with several panes the outside never yields a fill to apply", () => {
    const l = grid(3);
    const last = resolveDrop(l, l.panes[0].id, 1.2, 0.4);
    expect(decideDragEnd({ ...idle, last })).toBeNull();
  });
});

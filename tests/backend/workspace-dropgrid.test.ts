import { describe, expect, it } from "vitest";
import {
  applyDrop,
  computeRects,
  dropPreview,
  emptyIds,
  isValidTree,
  resolveDrop,
  treeIds,
  zoneRect,
  type Layout,
  type LayoutNode,
  type Rect,
} from "../../src/frontend/workspace/layout";

// Every arrangement of 2 and 3 panes over a 2x2 of cells (rest empty), both
// split orientations, dropped on a 10x10 grid of pointer positions.
function build(mask: number[], colFirst: boolean): Layout {
  const ids: string[] = [];
  let e = 0;
  const cell = (on: number, n: number): LayoutNode => {
    if (on) {
      const id = `p${ids.length}`;
      ids.push(id);
      return { type: "pane", id };
    }
    return { type: "empty", id: `e${e++}${n}` };
  };
  const c = mask.map((m, n) => cell(m, n));
  const pair = (
    a: LayoutNode,
    b: LayoutNode,
    dir: "row" | "col",
  ): LayoutNode => ({
    type: "split",
    dir,
    children: [a, b],
  });
  const inner = colFirst ? "col" : "row";
  const outer = colFirst ? "row" : "col";
  // cells in reading order: tl tr bl br
  const tree = colFirst
    ? pair(pair(c[0], c[2], inner), pair(c[1], c[3], inner), outer)
    : pair(pair(c[0], c[1], inner), pair(c[2], c[3], inner), outer);
  return {
    panes: ids.map((id) => ({ id, kind: "container", containerId: id })),
    tree,
    activeId: ids[0],
    seq: 100,
  };
}

const close = (a: Rect, b: Rect) =>
  ["x", "y", "w", "h"].every(
    (k) => Math.abs(a[k as keyof Rect] - b[k as keyof Rect]) < 1e-6,
  );

function overlap(a: Rect, b: Rect) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 1e-9 && h > 1e-9 ? w * h : 0;
}

describe("exhaustive pane drops in a 2x2 with empty cells", () => {
  const layouts: Layout[] = [];
  for (let m = 0; m < 16; m++) {
    const mask = [m & 1, (m >> 1) & 1, (m >> 2) & 1, (m >> 3) & 1];
    const n = mask.reduce((a, b) => a + b, 0);
    if (n !== 2 && n !== 3) continue;
    layouts.push(build(mask, false), build(mask, true));
  }

  it("keeps panes valid, swaps minimal, free docks static, preview exact", () => {
    let swaps = 0;
    let freeDocks = 0;
    for (const l of layouts) {
      const before = computeRects(l.tree);
      const free = [...emptyIds(l.tree)];
      for (const { id } of l.panes) {
        for (let i = 0; i < 10; i++)
          for (let j = 0; j < 10; j++) {
            const t = resolveDrop(l, id, (i + 0.5) / 10, (j + 0.5) / 10);
            if (!t) continue;
            const ctx = JSON.stringify({ t, id, tree: l.tree, i, j });
            const next = applyDrop(l, id, t);
            // (a)
            expect(isValidTree(next.tree), ctx).toBe(true);
            expect(treeIds(next.tree).sort(), ctx).toEqual(
              l.panes.map((p) => p.id).sort(),
            );
            const after = computeRects(next.tree);
            if (t.kind === "swap") {
              swaps++;
              // (b)
              for (const [k, r] of before) {
                const swappedWith =
                  k === id ? t.withId : k === t.withId ? id : k;
                expect(
                  close(after.get(k)!, before.get(swappedWith)!),
                  ctx,
                ).toBe(true);
                expect(r).toBeDefined();
              }
            }
            if (t.kind === "zone") {
              // (c) zone wholly in free space: the other panes stay put
              const z = zoneRect(t.zone);
              const freeRects = [
                before.get(id)!,
                ...free.map((f) => before.get(f)!),
              ];
              const covered = freeRects.reduce((a, r) => a + overlap(r, z), 0);
              if (Math.abs(covered - z.w * z.h) < 1e-9) {
                freeDocks++;
                for (const p of l.panes)
                  if (p.id !== id)
                    expect(
                      close(after.get(p.id)!, before.get(p.id)!),
                      ctx,
                    ).toBe(true);
              }
            }
            // (d)
            const pv = dropPreview(l, id, t);
            expect(pv.rects.length, ctx).toBe(1);
            expect(close(pv.rects[0], after.get(id)!), ctx).toBe(true);
          }
      }
    }
    expect(swaps).toBeGreaterThan(0);
    expect(freeDocks).toBeGreaterThan(0);
  });

  it("dropping onto another pane always swaps, whatever the part hit", () => {
    for (const l of layouts) {
      const rects = computeRects(l.tree);
      for (const { id } of l.panes)
        for (const o of l.panes) {
          if (o.id === id) continue;
          const r = rects.get(o.id)!;
          for (const f of [0.2, 0.5, 0.8]) {
            const fx = r.x + r.w * f;
            const fy = r.y + r.h * (1 - f);
            if (fx < 0.12 || fx > 0.88 || fy < 0.12 || fy > 0.88) continue;
            expect(resolveDrop(l, id, fx, fy)).toEqual({
              kind: "swap",
              withId: o.id,
            });
          }
        }
    }
  });

  it("two panes sharing the screen 50/50 just swap", () => {
    const l: Layout = {
      panes: ["a", "b"].map((id) => ({
        id,
        kind: "container",
        containerId: id,
      })),
      tree: {
        type: "split",
        dir: "row",
        children: [
          { type: "pane", id: "a" },
          { type: "pane", id: "b" },
        ],
      },
      activeId: "a",
      seq: 5,
    };
    const t = resolveDrop(l, "a", 0.55, 0.5)!;
    expect(t).toEqual({ kind: "swap", withId: "b" });
    const r = computeRects(applyDrop(l, "a", t).tree);
    expect(r.get("a")).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(r.get("b")).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
  });
});

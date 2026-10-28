import { describe, expect, it } from "vitest";
import {
  computeRects,
  emptyIds,
  workspaceZoneAt,
  emptyLayout,
  layoutReducer,
  parseLayout,
  readSessionLayout,
  writeSessionLayout,
  serializeLayout,
  treeIds,
  type Layout,
} from "../../src/frontend/workspace/layout";
import en from "../../locales-src/en.json";
import ru from "../../locales-src/ru.json";

function grid(n: number): Layout {
  let l = emptyLayout();
  for (let i = 0; i < n; i++)
    l = layoutReducer(l, { type: "add", containerId: `c${i}` });
  return l;
}

const rect = (l: Layout, i: number) => computeRects(l.tree).get(l.panes[i].id)!;

describe("grid layout", () => {
  it("2 panes are side by side", () => {
    const l = grid(2);
    expect(rect(l, 0)).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(rect(l, 1)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it("3 panes: two on top, one spanning the bottom", () => {
    const l = grid(3);
    expect(rect(l, 0)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(rect(l, 2)).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });

  it("4 panes make a 2x2 grid", () => {
    const l = grid(4);
    for (let i = 0; i < 4; i++) {
      const r = rect(l, i);
      expect([r.w, r.h]).toEqual([0.5, 0.5]);
    }
    expect(rect(l, 3)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it("closing a pane re-flows the rest", () => {
    let l = grid(3);
    l = layoutReducer(l, { type: "close", id: l.panes[2].id });
    expect(rect(l, 0)).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(treeIds(l.tree).sort()).toEqual(l.panes.map((p) => p.id).sort());
  });
});

describe("pane drag (whole workspace)", () => {
  it("2+ panes: left dock gives the dragged pane the left half", () => {
    let l = grid(3);
    const id = l.panes[2].id;
    l = layoutReducer(l, { type: "dock", id, zone: "left" });
    expect(computeRects(l.tree).get(id)).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    for (const p of l.panes.filter((q) => q.id !== id)) {
      const r = computeRects(l.tree).get(p.id)!;
      expect(r.x).toBeGreaterThanOrEqual(0.5);
    }
    expect(emptyIds(l.tree)).toEqual([]);
    expect(l.activeId).toBe(id);
  });

  it("bottom dock stacks the dragged pane under the rest", () => {
    let l = grid(2);
    const id = l.panes[0].id;
    l = layoutReducer(l, { type: "dock", id, zone: "bottom" });
    expect(computeRects(l.tree).get(id)).toEqual({
      x: 0,
      y: 0.5,
      w: 1,
      h: 0.5,
    });
    expect(rect(l, 1)).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
  });

  it("a single pane takes the chosen half and leaves an empty slot", () => {
    let l = grid(1);
    const id = l.panes[0].id;
    l = layoutReducer(l, { type: "dock", id, zone: "right" });
    expect(computeRects(l.tree).get(id)).toEqual({
      x: 0.5,
      y: 0,
      w: 0.5,
      h: 1,
    });
    expect(emptyIds(l.tree)).toHaveLength(1);
    expect(treeIds(l.tree)).toEqual([id]);
  });

  it("a corner gives a quarter; the rest is empty slots", () => {
    let l = grid(1);
    const id = l.panes[0].id;
    l = layoutReducer(l, { type: "dock", id, zone: "bottomRight" });
    expect(computeRects(l.tree).get(id)).toEqual({
      x: 0.5,
      y: 0.5,
      w: 0.5,
      h: 0.5,
    });
    const rects = computeRects(l.tree);
    const area = emptyIds(l.tree).reduce((n, e) => {
      const r = rects.get(e)!;
      return n + r.w * r.h;
    }, 0);
    expect(area).toBeCloseTo(0.75);
  });

  it("an empty slot is filled by add and counts toward the pane limit", () => {
    let l = grid(1);
    l = layoutReducer(l, { type: "dock", id: l.panes[0].id, zone: "left" });
    const slot = emptyIds(l.tree)[0];
    l = layoutReducer(l, { type: "add", containerId: null, emptyId: slot });
    expect(emptyIds(l.tree)).toEqual([]);
    expect(computeRects(l.tree).get(l.panes[1].id)).toEqual({
      x: 0.5,
      y: 0,
      w: 0.5,
      h: 1,
    });
  });

  it("closing the last pane clears empty slots", () => {
    let l = grid(1);
    l = layoutReducer(l, { type: "dock", id: l.panes[0].id, zone: "top" });
    l = layoutReducer(l, { type: "close", id: l.panes[0].id });
    expect(l.tree).toBeNull();
  });

  it("unknown pane is a no-op and every pane stays exactly once", () => {
    const l = grid(4);
    expect(layoutReducer(l, { type: "dock", id: "x", zone: "left" })).toBe(l);
    const d = layoutReducer(l, {
      type: "dock",
      id: l.panes[0].id,
      zone: "topRight",
    });
    expect(treeIds(d.tree).sort()).toEqual(d.panes.map((p) => p.id).sort());
  });

  it("picks the zone from the pointer position", () => {
    expect(workspaceZoneAt(0.1, 0.5)).toBe("left");
    expect(workspaceZoneAt(0.9, 0.5)).toBe("right");
    expect(workspaceZoneAt(0.5, 0.1)).toBe("top");
    expect(workspaceZoneAt(0.5, 0.9)).toBe("bottom");
    expect(workspaceZoneAt(0.1, 0.1)).toBe("topLeft");
    expect(workspaceZoneAt(0.9, 0.9)).toBe("bottomRight");
    expect(workspaceZoneAt(0.9, 0.1)).toBe("topRight");
    expect(workspaceZoneAt(0.1, 0.9)).toBe("bottomLeft");
  });

  it("persists the arrangement (with empty slots) and rebuilds a broken one", () => {
    let l = grid(2);
    l = layoutReducer(l, { type: "dock", id: l.panes[1].id, zone: "topLeft" });
    expect(emptyIds(l.tree)).toHaveLength(1);
    expect(parseLayout(serializeLayout(l))).toEqual(l);
    const broken = JSON.parse(serializeLayout(l));
    broken.tree = { type: "pane", id: "ghost" };
    const fixed = parseLayout(JSON.stringify(broken));
    expect(treeIds(fixed.tree).sort()).toEqual(l.panes.map((p) => p.id).sort());
    const old = JSON.parse(serializeLayout(l));
    delete old.tree;
    expect(parseLayout(JSON.stringify(old)).tree).not.toBeNull();
  });
});

describe("session scoped layout", () => {
  it("a different session never sees another session's panes", () => {
    writeSessionLayout("s1", serializeLayout(grid(3)));
    expect(parseLayout(readSessionLayout("s2")).panes).toHaveLength(0);
    expect(parseLayout(readSessionLayout("s1")).panes).toHaveLength(3);
  });
});

describe("locale placeholders", () => {
  it("workspace strings use the SDK's {{param}} syntax", () => {
    for (const dict of [en, ru]) {
      const bad = Object.entries(dict.workspace as Record<string, unknown>)
        .filter(([, v]) => typeof v === "string")
        .filter(([, v]) => /(^|[^{])\{[a-zA-Z]+\}($|[^}])/.test(v as string));
      expect(bad).toEqual([]);
    }
  });
});

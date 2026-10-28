import { describe, expect, it } from "vitest";
import {
  MAX_PANES,
  MIN_RATIO,
  computeRects,
  computeSplitters,
  emptyIds,
  emptyLayout,
  isValidTree,
  layoutReducer,
  parseLayout,
  serializeLayout,
  treeIds,
  resolveDrop,
  type Layout,
  type LayoutAction,
  type LayoutNode,
  type WorkspaceZone,
} from "../../src/frontend/workspace/layout";

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ZONES: WorkspaceZone[] = [
  "left",
  "right",
  "top",
  "bottom",
  "topLeft",
  "topRight",
  "bottomLeft",
  "bottomRight",
];

/** Every structural rule a stored or produced layout must satisfy. */
function violations(l: Layout): string[] {
  const out: string[] = [];
  const ids = l.panes.map((p) => p.id);
  if (new Set(ids).size !== ids.length) out.push("duplicate pane ids");
  if (ids.length > MAX_PANES) out.push("too many panes");
  if (ids.length === 0) {
    if (l.tree !== null) out.push("tree without panes");
    if (l.activeId !== null) out.push("active without panes");
    return out;
  }
  if (!l.tree) return [...out, "panes without tree"];
  const inTree = treeIds(l.tree);
  if (
    inTree.length !== ids.length ||
    new Set(inTree).size !== inTree.length ||
    !ids.every((i) => inTree.includes(i))
  )
    out.push(`tree leaves ${inTree} differ from panes ${ids}`);
  const empties = emptyIds(l.tree);
  if (new Set(empties).size !== empties.length) out.push("duplicate empties");
  if (empties.some((e) => ids.includes(e))) out.push("empty id = pane id");
  if (l.activeId !== null && !ids.includes(l.activeId))
    out.push("active pane unknown");
  if (l.activeId === null) out.push("no active pane");
  const walk = (n: LayoutNode, path: string) => {
    if (n.type !== "split") return;
    if (n.children.length < 2) out.push(`split at ${path} has <2 children`);
    if (n.children.length > 2) out.push(`split at ${path} has >2 children`);
    if (n.ratios) {
      const sum = n.ratios.reduce((a, b) => a + b, 0);
      if (
        n.ratios.length !== n.children.length ||
        Math.abs(sum - 1) > 1e-6 ||
        n.ratios.some((r) => !(r >= MIN_RATIO - 1e-6 && r < 1))
      )
        out.push(`bad ratios at ${path}: ${n.ratios}`);
    }
    if (n.children.every((c) => c.type === "empty"))
      out.push(`empty-only split at ${path}`);
    for (const c of n.children)
      if (c.type === "split" && c.dir === n.dir)
        out.push(`nested same-direction split at ${path}`);
    n.children.forEach((c, i) => walk(c, `${path}/${i}`));
  };
  walk(l.tree, "");
  if (!isValidTree(l.tree)) out.push("three tiles in a row or column");
  const rects = [...computeRects(l.tree).values()];
  const area = rects.reduce((a, r) => a + r.w * r.h, 0);
  if (Math.abs(area - 1) > 1e-6) out.push(`tiles cover ${area}`);
  if (rects.length > 4) out.push("more than four tiles");
  return out;
}

function randomAction(l: Layout, rand: () => number): LayoutAction {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const paneIds = l.panes.map((p) => p.id);
  const slots = emptyIds(l.tree);
  const anyLeaf = [...paneIds, ...slots];
  const splitters = computeSplitters(l.tree);
  const roll = rand();
  if (roll < 0.14)
    return {
      type: "add",
      containerId: rand() < 0.5 ? null : `c${Math.floor(rand() * 9)}`,
      emptyId: slots.length && rand() < 0.5 ? pick(slots) : undefined,
    };
  if (roll < 0.18)
    return {
      type: "addLocal",
      emptyId: slots.length && rand() < 0.5 ? pick(slots) : undefined,
    };
  if (roll < 0.22)
    return { type: "open", containerId: `c${Math.floor(rand() * 9)}` };
  if (roll < 0.34 && paneIds.length)
    return { type: "close", id: pick(paneIds) };
  if (roll < 0.46 && paneIds.length)
    return { type: "dock", id: pick(paneIds), zone: pick(ZONES) };
  if (roll < 0.56 && paneIds.length && anyLeaf.length)
    return { type: "swap", id: pick(paneIds), withId: pick(anyLeaf) };
  if (roll < 0.7 && paneIds.length) {
    const id = pick(paneIds);
    const f = () => (rand() < 0.15 ? (rand() < 0.5 ? -1 : 2) : rand());
    const target = resolveDrop(l, id, f(), f());
    if (target) return { type: "drop", id, target };
  }
  if (roll < 0.78 && slots.length)
    return { type: "closeEmpty", id: pick(slots) };
  if (roll < 0.86 && splitters.length) {
    const s = pick(splitters);
    return { type: "absorb", path: s.path, index: s.index };
  }
  if (roll < 0.94 && splitters.length) {
    const s = pick(splitters);
    return {
      type: "resize",
      path: s.path,
      index: s.index,
      position: rand() * 1.4 - 0.2,
    };
  }
  if (roll < 0.97 && splitters.length)
    return { type: "resetRatios", path: pick(splitters).path };
  if (roll < 0.99 && paneIds.length)
    return { type: "activate", id: pick(paneIds) };
  return { type: "prune", existing: new Set(["c1", "c2", "c3", "c4", "c5"]) };
}

function start(rand: () => number): Layout {
  let l = emptyLayout();
  const n = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++)
    l = layoutReducer(l, { type: "add", containerId: `c${i}` });
  return l;
}

describe("random layout operations keep the layout valid", () => {
  it("starting layouts are valid", () => {
    for (let n = 1; n <= 4; n++) {
      let l = emptyLayout();
      for (let i = 0; i < n; i++)
        l = layoutReducer(l, { type: "add", containerId: `c${i}` });
      expect(violations(l)).toEqual([]);
    }
  });

  it("long random sequences of every operation", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 500; seed++) {
      const rand = rng(seed);
      let l = start(rand);
      const log: string[] = [];
      for (let step = 0; step < 150; step++) {
        const action = randomAction(l, rand);
        const before = l;
        l = layoutReducer(l, action);
        log.push(
          JSON.stringify(action, (_k, v) => (v instanceof Set ? [...v] : v)),
        );
        const bad = violations(l);
        // A reloaded layout must be as valid as the live one.
        const again = parseLayout(serializeLayout(l));
        const badAgain = violations(again);
        if (bad.length || badAgain.length) {
          failures.push(
            `seed ${seed} step ${step}: ${[...bad, ...badAgain.map((b) => `reload: ${b}`)].join("; ")}\n` +
              `  before ${JSON.stringify(before.tree)}\n  after  ${JSON.stringify(l.tree)}\n  action ${log[log.length - 1]}`,
          );
          break;
        }
      }
    }
    expect(failures.slice(0, 5).join("\n")).toBe("");
    expect(failures.length).toBe(0);
  }, 60_000);

  const pane = (id: string): LayoutNode => ({ type: "pane", id });
  const empty = (id: string): LayoutNode => ({ type: "empty", id });
  const split = (
    dir: "row" | "col",
    ...children: LayoutNode[]
  ): LayoutNode => ({ type: "split", dir, children });
  const stored = (tree: LayoutNode, ids: string[]) =>
    JSON.stringify({
      panes: ids.map((id) => ({ id, kind: "container", containerId: id })),
      tree,
      activeId: ids[0],
      seq: 30,
    });

  it("a fourth pane joins a hand-made three pane layout as a grid", () => {
    const three: Layout = {
      panes: ["a", "b", "c"].map((id) => ({
        id,
        kind: "container" as const,
        containerId: id,
      })),
      tree: split("col", pane("a"), split("row", pane("b"), pane("c"))),
      activeId: "a",
      seq: 10,
    };
    const l = layoutReducer(three, { type: "add", containerId: null });
    expect(violations(l)).toEqual([]);
    expect(l.panes).toHaveLength(4);
  });

  it("side by side empty slots become one slot", () => {
    const l: Layout = {
      panes: [{ id: "a", kind: "container", containerId: "a" }],
      tree: split("col", pane("a"), split("row", empty("e1"), empty("e2"))),
      activeId: "a",
      seq: 10,
    };
    const next = layoutReducer(l, { type: "resetRatios", path: [] });
    expect(emptyIds(next.tree)).toEqual(["e1"]);
    expect(violations(next)).toEqual([]);
  });

  it("loading repairs a stored layout that breaks the rules", () => {
    const three = split("row", pane("a"), pane("b"), pane("c"));
    expect(violations(parseLayout(stored(three, ["a", "b", "c"])))).toEqual([]);
    const dupEmpty = split(
      "col",
      pane("a"),
      split("row", empty("e"), empty("e")),
    );
    expect(violations(parseLayout(stored(dupEmpty, ["a"])))).toEqual([]);
    const emptyPair = split(
      "col",
      pane("a"),
      split("row", empty("e1"), empty("e2")),
    );
    const loaded = parseLayout(stored(emptyPair, ["a"]));
    expect(violations(loaded)).toEqual([]);
    expect(emptyIds(loaded.tree)).toEqual(["e1"]);
  });
});

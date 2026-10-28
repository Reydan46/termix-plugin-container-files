// Pure pane layout of the multi-pane workspace: a reducer plus (de)serialisation.
// A `local` pane (the user's own computer, Desktop only) sits among the
// container panes; at most one.

export const MAX_PANES = 4;

export interface ContainerPane {
  id: string;
  kind: "container";
  /** null while the pane still shows the container picker. */
  containerId: string | null;
}

export interface LocalPane {
  id: string;
  kind: "local";
  containerId?: undefined;
}

export type Pane = ContainerPane | LocalPane;

type DropZone = "left" | "right" | "top" | "bottom";

/**
 * Where a dragged pane docks in the whole workspace: a half (edges) or a
 * quarter (corners).
 */
export type WorkspaceZone =
  DropZone | "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

/**
 * Tiling tree: leaves are pane ids (or empty slots), splits lay children out
 * in a row/column. An empty slot renders an "add container" placeholder.
 */
export type LayoutNode =
  | { type: "pane"; id: string }
  | { type: "empty"; id: string }
  | {
      type: "split";
      dir: "row" | "col";
      children: LayoutNode[];
      /**
       * Share of each child (fractions summing to 1). Absent or of the wrong
       * length means equal shares.
       */
      ratios?: number[];
    };

/** Smallest share a child may be dragged down to. */
export const MIN_RATIO = 0.15;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  panes: Pane[];
  /** Arrangement of the panes; its leaves are exactly the pane ids. */
  tree: LayoutNode | null;
  activeId: string | null;
  /** Next id suffix; never reused inside one layout. */
  seq: number;
}

export type LayoutAction =
  | { type: "add"; containerId: string | null; emptyId?: string }
  | { type: "addLocal"; emptyId?: string }
  | { type: "open"; containerId: string }
  | { type: "close"; id: string }
  | { type: "setContainer"; id: string; containerId: string | null }
  | { type: "activate"; id: string }
  | { type: "dock"; id: string; zone: WorkspaceZone }
  /** Exchanges a pane with another pane or moves it into an empty slot. */
  | { type: "swap"; id: string; withId: string }
  | { type: "drop"; id: string; target: DropTarget }
  | {
      type: "resize";
      /** Child indexes from the root to the split. */
      path: number[];
      /** The splitter after child `index`. */
      index: number;
      /** New boundary position as a fraction (0..1) of the split's extent. */
      position: number;
    }
  | { type: "resetRatios"; path: number[] }
  /** Removes an empty slot; its neighbour grows into the freed space. */
  | { type: "closeEmpty"; id: string }
  /** The splitter's pane takes over the empty slot beside the splitter. */
  | { type: "absorb"; path: number[]; index: number }
  | { type: "prune"; existing: ReadonlySet<string> };

export function emptyLayout(): Layout {
  return { panes: [], tree: null, activeId: null, seq: 1 };
}

// ---- tiling tree --------------------------------------------------------

const leaf = (id: string): LayoutNode => ({ type: "pane", id });

/**
 * Drops empty splits, unwraps single-child splits and turns a split of only
 * empty slots into one slot; a split revealed by unwrapping merges into a
 * same-direction parent (deliberate nesting stays).
 */
export function normalize(node: LayoutNode | null): LayoutNode | null {
  if (!node || node.type !== "split") return node;
  const children: LayoutNode[] = [];
  for (const raw of node.children) {
    const child = normalize(raw);
    if (!child) continue;
    if (
      child.type === "split" &&
      child.dir === node.dir &&
      raw.type === "split" &&
      raw.dir !== node.dir
    )
      children.push(...child.children);
    else children.push(child);
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  // Side by side empty slots are one bigger slot.
  if (children.every((c) => c.type === "empty")) return children[0];
  // A merge or a dropped child changes the count: back to equal shares.
  return withChildren(node, children);
}

/**
 * Replaces a split's children; the ratios survive only when the child count is
 * unchanged (otherwise the split goes back to equal shares).
 */
function withChildren(
  node: Extract<LayoutNode, { type: "split" }>,
  children: LayoutNode[],
): LayoutNode {
  const { ratios, ...rest } = node;
  return ratios && ratios.length === children.length
    ? { ...rest, children, ratios }
    : { ...rest, children };
}

/** Pane ids in the tree (empty slots excluded). */
export function treeIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.type === "split") return node.children.flatMap(treeIds);
  return node.type === "pane" ? [node.id] : [];
}

/** Ids of the empty slots in the tree. */
export function emptyIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.type === "split") return node.children.flatMap(emptyIds);
  return node.type === "empty" ? [node.id] : [];
}

function removeEmpties(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.type !== "split") return node.type === "empty" ? null : node;
  return normalize({
    ...node,
    children: node.children
      .map(removeEmpties)
      .filter((c): c is LayoutNode => c !== null),
  });
}

function replaceLeaf(node: LayoutNode, id: string, by: LayoutNode): LayoutNode {
  if (node.type !== "split") return node.id === id ? by : node;
  return {
    ...node,
    children: node.children.map((c) => replaceLeaf(c, id, by)),
  };
}

function removeLeaf(node: LayoutNode | null, id: string): LayoutNode | null {
  if (!node) return null;
  if (node.type !== "split") return node.id === id ? null : node;
  const children: LayoutNode[] = [];
  for (const c of node.children) {
    const r = removeLeaf(c, id);
    if (r) children.push(r);
  }
  return normalize({ ...node, children });
}

function splitLeaf(
  node: LayoutNode,
  targetId: string,
  newId: string,
  zone: DropZone,
): LayoutNode {
  if (node.type !== "split") {
    if (node.type !== "pane" || node.id !== targetId) return node;
    const before = zone === "left" || zone === "top";
    return {
      type: "split",
      dir: zone === "left" || zone === "right" ? "row" : "col",
      children: before ? [leaf(newId), node] : [node, leaf(newId)],
    };
  }
  return {
    ...node,
    children: node.children.map((c) => splitLeaf(c, targetId, newId, zone)),
  };
}

/**
 * Adds a pane in the default arrangement: 2 side by side, the 3rd spans the
 * bottom, the 4th shares the bottom row (a 2x2 grid).
 */
function appendLeaf(tree: LayoutNode | null, id: string): LayoutNode {
  const out = appendLeafDefault(tree, id);
  if (!tree || isValidTree(out)) return out;
  // The default shape would put three tiles in a row or column (the tree was
  // arranged by hand): split a pane that has room beside it instead.
  const ids = treeIds(tree);
  for (const pid of readingOrder(tree, ids))
    for (const zone of ["right", "bottom", "left", "top"] as const) {
      const next = normalize(splitLeaf(tree, pid, id, zone));
      if (next && isValidTree(next)) return next;
    }
  return out;
}

function appendLeafDefault(tree: LayoutNode | null, id: string): LayoutNode {
  if (!tree) return leaf(id);
  const fallback = (t: LayoutNode): LayoutNode =>
    t.type === "split"
      ? withChildren(t, [...t.children, leaf(id)])
      : { type: "split", dir: "row", children: [t, leaf(id)] };
  if (tree.type !== "split") return fallback(tree);
  if (tree.dir === "row" && tree.children.length === 2)
    return { type: "split", dir: "col", children: [tree, leaf(id)] };
  if (tree.dir === "col") {
    const last = tree.children[tree.children.length - 1];
    if (last.type === "pane")
      return {
        ...tree,
        children: [
          ...tree.children.slice(0, -1),
          { type: "split", dir: "row", children: [last, leaf(id)] },
        ],
      };
    return fallback(tree);
  }
  const lone = tree.children.find((c) => c.type === "pane");
  if (lone && lone.type === "pane")
    return normalize(splitLeaf(tree, lone.id, id, "bottom")) ?? fallback(tree);
  return fallback(tree);
}

const CORNER = 0.25;

/** Which workspace zone a pointer at (fx, fy) in 0..1 points to. */
export function workspaceZoneAt(fx: number, fy: number): WorkspaceZone {
  const h = fx < CORNER ? "Left" : fx > 1 - CORNER ? "Right" : null;
  const v = fy < CORNER ? "top" : fy > 1 - CORNER ? "bottom" : null;
  if (h && v) return `${v}${h}` as WorkspaceZone;
  const dx = fx - 0.5;
  const dy = fy - 0.5;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "top" : "bottom";
}

/** The part of the workspace (0..1) highlighted for a drop zone. */
export function zoneRect(zone: WorkspaceZone): Rect {
  switch (zone) {
    case "left":
      return { x: 0, y: 0, w: 0.5, h: 1 };
    case "right":
      return { x: 0.5, y: 0, w: 0.5, h: 1 };
    case "top":
      return { x: 0, y: 0, w: 1, h: 0.5 };
    case "bottom":
      return { x: 0, y: 0.5, w: 1, h: 0.5 };
    case "topLeft":
      return { x: 0, y: 0, w: 0.5, h: 0.5 };
    case "topRight":
      return { x: 0.5, y: 0, w: 0.5, h: 0.5 };
    case "bottomLeft":
      return { x: 0, y: 0.5, w: 0.5, h: 0.5 };
    case "bottomRight":
      return { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
  }
}

type SplitNode = Extract<LayoutNode, { type: "split" }>;

/** Valid ratios of a split, else equal shares. */
export function splitRatios(node: SplitNode): number[] {
  const n = node.children.length;
  const r = node.ratios;
  if (
    r &&
    r.length === n &&
    r.every((x) => Number.isFinite(x) && x > 0) &&
    Math.abs(r.reduce((a, b) => a + b, 0) - 1) < 1e-6
  )
    return r;
  return Array.from({ length: n }, () => 1 / n);
}

function childRect(dir: "row" | "col", r: Rect, at: number, share: number) {
  return dir === "row"
    ? { x: r.x + r.w * at, y: r.y, w: r.w * share, h: r.h }
    : { x: r.x, y: r.y + r.h * at, w: r.w, h: r.h * share };
}

/** Rectangles (fractions of the workspace) of every leaf. */
export function computeRects(node: LayoutNode | null): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const walk = (n: LayoutNode, r: Rect) => {
    if (n.type !== "split") {
      out.set(n.id, r);
      return;
    }
    const ratios = splitRatios(n);
    let at = 0;
    n.children.forEach((child, i) => {
      walk(child, childRect(n.dir, r, at, ratios[i]));
      at += ratios[i];
    });
  };
  if (node) walk(node, { x: 0, y: 0, w: 1, h: 1 });
  return out;
}

export interface Splitter {
  /** Stable key: the split's path plus the index. */
  key: string;
  path: number[];
  /** The splitter sits after child `index`. */
  index: number;
  /** Direction of the split: "row" children sit side by side. */
  dir: "row" | "col";
  /** The split's own rectangle (fractions of the workspace). */
  rect: Rect;
  /** Boundary position inside the split, 0..1. */
  offset: number;
}

/** Draggable boundaries between the children of every split. */
export function computeSplitters(node: LayoutNode | null): Splitter[] {
  const out: Splitter[] = [];
  const walk = (n: LayoutNode, r: Rect, path: number[]) => {
    if (n.type !== "split") return;
    const ratios = splitRatios(n);
    let at = 0;
    n.children.forEach((child, i) => {
      walk(child, childRect(n.dir, r, at, ratios[i]), [...path, i]);
      at += ratios[i];
      if (i < n.children.length - 1)
        out.push({
          key: `${path.join(".")}|${i}`,
          path,
          index: i,
          dir: n.dir,
          rect: r,
          offset: at,
        });
    });
  };
  if (node) walk(node, { x: 0, y: 0, w: 1, h: 1 }, []);
  return out;
}

function updateAt(
  node: LayoutNode | null,
  path: number[],
  fn: (split: SplitNode) => LayoutNode,
): LayoutNode | null {
  if (!node || node.type !== "split") return node;
  if (path.length === 0) return fn(node);
  const [head, ...tail] = path;
  if (head < 0 || head >= node.children.length) return node;
  return {
    ...node,
    children: node.children.map((c, i) =>
      i === head ? (updateAt(c, tail, fn) ?? c) : c,
    ),
  };
}

/**
 * Moves the splitter after child `index` to `position` (fraction of the
 * split), keeping both neighbours at least MIN_RATIO of the split.
 */
export function resizeSplit(
  tree: LayoutNode | null,
  path: number[],
  index: number,
  position: number,
): LayoutNode | null {
  if (!Number.isFinite(position)) return tree;
  return updateAt(tree, path, (split) => {
    if (index < 0 || index >= split.children.length - 1) return split;
    const ratios = [...splitRatios(split)];
    const before = ratios.slice(0, index).reduce((a, b) => a + b, 0);
    const pair = ratios[index] + ratios[index + 1];
    if (pair < MIN_RATIO * 2) return split;
    const a = Math.min(
      pair - MIN_RATIO,
      Math.max(MIN_RATIO, position - before),
    );
    ratios[index] = a;
    ratios[index + 1] = pair - a;
    return { ...split, ratios };
  });
}

/** Back to equal shares for the split at `path`. */
export function resetSplit(
  tree: LayoutNode | null,
  path: number[],
): LayoutNode | null {
  return updateAt(tree, path, (split) => {
    const { ratios: _ratios, ...rest } = split;
    return rest;
  });
}

/**
 * Removes the empty slot `id` from the split that holds it; the freed share
 * goes to the neighbour on the given side (the other one at the ends). A split
 * left with one child stays as a wrapper for normalize to unwrap.
 */
function dropSlot(
  node: LayoutNode,
  id: string,
  grow: "before" | "after",
): LayoutNode {
  if (node.type !== "split") return node;
  const i = node.children.findIndex((c) => c.type === "empty" && c.id === id);
  if (i < 0)
    return {
      ...node,
      children: node.children.map((c) => dropSlot(c, id, grow)),
    };
  const children = node.children.filter((_, k) => k !== i);
  if (children.length === 1) {
    const { ratios: _ratios, ...rest } = node;
    return { ...rest, children };
  }
  const old = splitRatios(node);
  const ratios = old.filter((_, k) => k !== i);
  const to =
    grow === "before" ? Math.max(i - 1, 0) : Math.min(i, children.length - 1);
  ratios[to] += old[i];
  return { ...node, children, ratios };
}

/**
 * Closes an empty slot: its neighbour (a pane or a whole subtree) grows into
 * the freed space; when the slot was the only sibling the parent collapses
 * into the other side.
 */
export function closeEmptySlot(
  tree: LayoutNode | null,
  id: string,
): LayoutNode | null {
  if (!tree || tree.type !== "split" || !emptyIds(tree).includes(id))
    return tree;
  return normalize(dropSlot(tree, id, "before"));
}

/** Share of a split (0..1) an empty slot may shrink to before it is absorbed. */
export const ABSORB_SHARE = 0.25;

interface AbsorbSides {
  emptyId: string;
  /** The empty slot is the child after the splitter (else before it). */
  emptyAfter: boolean;
  /** Summed share of the children before the splitter's pair. */
  before: number;
  /** Summed share of the two children around the splitter. */
  pair: number;
}

/** The empty slot next to the splitter when the other side holds a pane/subtree. */
function absorbSides(
  tree: LayoutNode | null,
  path: number[],
  index: number,
): AbsorbSides | null {
  let node: LayoutNode | null = tree;
  for (const step of path)
    node = node && node.type === "split" ? (node.children[step] ?? null) : null;
  if (!node || node.type !== "split") return null;
  const a = node.children[index];
  const b = node.children[index + 1];
  if (!a || !b || (a.type === "empty") === (b.type === "empty")) return null;
  const ratios = splitRatios(node);
  return {
    emptyId: a.type === "empty" ? a.id : (b as { id: string }).id,
    emptyAfter: b.type === "empty",
    before: ratios.slice(0, index).reduce((x, y) => x + y, 0),
    pair: ratios[index] + ratios[index + 1],
  };
}

/**
 * Dragging the splitter after child `index` of the split at `path` to
 * `position` (fraction of the split, unclamped): the id of the empty slot that
 * would be absorbed by its neighbour, once the slot is squeezed below
 * ABSORB_SHARE of the split. Null when a pane sits on both sides or the slot
 * is still large enough.
 */
export function absorbTarget(
  tree: LayoutNode | null,
  path: number[],
  index: number,
  position: number,
): string | null {
  const s = absorbSides(tree, path, index);
  if (!s || !Number.isFinite(position)) return null;
  const share = s.emptyAfter
    ? s.before + s.pair - position
    : position - s.before;
  // A pair that is itself small never absorbs at the very start of a drag.
  return share < Math.min(ABSORB_SHARE, s.pair * 0.4) ? s.emptyId : null;
}

/**
 * The whole area the pane will occupy once it absorbs the empty slot beside
 * the splitter: the pane's side plus the slot's side, i.e. both children
 * around the splitter (fractions of the workspace). Null when the splitter has
 * no empty slot to absorb. It does not change while the splitter is dragged.
 */
export function absorbArea(
  tree: LayoutNode | null,
  path: number[],
  index: number,
): Rect | null {
  const s = absorbSides(tree, path, index);
  const sp = computeSplitters(tree).find(
    (x) => x.key === `${path.join(".")}|${index}`,
  );
  if (!s || !sp) return null;
  const { rect } = sp;
  return sp.dir === "row"
    ? {
        x: rect.x + rect.w * s.before,
        y: rect.y,
        w: rect.w * s.pair,
        h: rect.h,
      }
    : {
        x: rect.x,
        y: rect.y + rect.h * s.before,
        w: rect.w,
        h: rect.h * s.pair,
      };
}

/** The neighbour of the empty slot beside that splitter takes both areas. */
export function absorbEmpty(
  tree: LayoutNode | null,
  path: number[],
  index: number,
): LayoutNode | null {
  const s = absorbSides(tree, path, index);
  if (!tree || !s) return tree;
  return normalize(
    updateAt(tree, path, (split) =>
      dropSlot(split, s.emptyId, s.emptyAfter ? "before" : "after"),
    ),
  );
}

const EPS = 1e-6;

/**
 * A layout is valid when no horizontal or vertical line crosses more than two
 * tiles (panes or empty slots): never three in a row or column.
 */
export function isValidTree(tree: LayoutNode | null): boolean {
  const rects = [...computeRects(tree).values()];
  const ok = (lo: (r: Rect) => number, size: (r: Rect) => number) => {
    const edges = [
      ...new Set(rects.flatMap((r) => [lo(r), lo(r) + size(r)])),
    ].sort((a, b) => a - b);
    for (let i = 0; i + 1 < edges.length; i++) {
      const mid = (edges[i] + edges[i + 1]) / 2;
      const hits = rects.filter(
        (r) => mid > lo(r) + EPS && mid < lo(r) + size(r) - EPS,
      ).length;
      if (hits > 2) return false;
    }
    return true;
  };
  return (
    ok(
      (r) => r.y,
      (r) => r.h,
    ) && // horizontal lines: tiles of one row
    ok(
      (r) => r.x,
      (r) => r.w,
    )
  );
}

/** Pane ids in reading order (top to bottom, then left to right). */
function readingOrder(tree: LayoutNode | null, ids: string[]): string[] {
  const rects = computeRects(tree);
  const at = (i: string) => rects.get(i) ?? { x: 0, y: 0, w: 0, h: 0 };
  return [...ids].sort((a, b) => {
    const ra = at(a);
    const rb = at(b);
    return Math.abs(ra.y - rb.y) > EPS ? ra.y - rb.y : ra.x - rb.x;
  });
}

/** Exchanges two leaves (panes or empty slots); splits and ratios stay. */
export function swapLeaves(
  tree: LayoutNode | null,
  a: string,
  b: string,
): LayoutNode | null {
  if (!tree || a === b) return tree;
  const nodes = new Map<string, LayoutNode>();
  const collect = (n: LayoutNode) => {
    if (n.type === "split") n.children.forEach(collect);
    else if (n.id === a || n.id === b) nodes.set(n.id, n);
  };
  collect(tree);
  const na = nodes.get(a);
  const nb = nodes.get(b);
  if (!na || !nb) return tree;
  const walk = (n: LayoutNode): LayoutNode => {
    if (n.type === "split") return { ...n, children: n.children.map(walk) };
    return n.id === a ? nb : n.id === b ? na : n;
  };
  return walk(tree);
}

/**
 * Swaps pane id with another pane or an empty slot (a move). Every pane stays
 * exactly once and the arrangement keeps its shape and ratios.
 */
export function swapPanes(layout: Layout, id: string, withId: string): Layout {
  if (id === withId || !layout.panes.some((p) => p.id === id)) return layout;
  const known =
    layout.panes.some((p) => p.id === withId) ||
    emptyIds(layout.tree).includes(withId);
  if (!known) return layout;
  return {
    ...layout,
    tree: swapLeaves(layout.tree, id, withId),
    activeId: id,
  };
}

type Cell = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

const CELL_OF_ZONE: Record<WorkspaceZone, Cell> = {
  topLeft: "topLeft",
  topRight: "topRight",
  bottomLeft: "bottomLeft",
  bottomRight: "bottomRight",
  left: "topLeft",
  top: "topRight",
  right: "bottomRight",
  bottom: "bottomLeft",
};

/** The quarter of the workspace a pointer at (fx, fy) is in. */
export function quarterAt(fx: number, fy: number): Cell {
  return `${fy < 0.5 ? "top" : "bottom"}${fx < 0.5 ? "Left" : "Right"}` as Cell;
}

/** Four panes always form a 2x2 grid: docking moves into a cell by swapping. */
function dockIntoGrid(layout: Layout, id: string, zone: WorkspaceZone): Layout {
  const rects = computeRects(layout.tree);
  const cellOf = (i: string): Cell => {
    const r = rects.get(i);
    return r ? quarterAt(r.x + r.w / 2, r.y + r.h / 2) : "topLeft";
  };
  const ids = layout.panes.map((p) => p.id);
  const cells = new Map(ids.map((i) => [i, cellOf(i)]));
  const byCell = (c: Cell) => ids.find((i) => cells.get(i) === c);
  const t = layout.tree;
  const isGrid =
    t?.type === "split" &&
    t.children.length === 2 &&
    t.children.every(
      (c) =>
        c.type === "split" &&
        c.dir !== t.dir &&
        c.children.length === 2 &&
        c.children.every((l) => l.type === "pane"),
    ) &&
    new Set(cells.values()).size === 4;
  const target = CELL_OF_ZONE[zone];
  if (isGrid) {
    const occupant = byCell(target);
    return occupant
      ? { ...layout, tree: swapLeaves(t, id, occupant), activeId: id }
      : layout;
  }
  // Not a proper grid (e.g. restored from older data): rebuild in reading order.
  const order = readingOrder(layout.tree, ids);
  const slots: Cell[] = ["topLeft", "topRight", "bottomLeft", "bottomRight"];
  const placed = new Map<Cell, string>(
    slots.map((c, i) => [c, order[i]] as [Cell, string]),
  );
  const from = slots.find((c) => placed.get(c) === id)!;
  const other = placed.get(target)!;
  placed.set(target, id);
  placed.set(from, other);
  const p = (c: Cell) => leaf(placed.get(c)!);
  return {
    ...layout,
    tree: {
      type: "split",
      dir: "col",
      children: [
        { type: "split", dir: "row", children: [p("topLeft"), p("topRight")] },
        {
          type: "split",
          dir: "row",
          children: [p("bottomLeft"), p("bottomRight")],
        },
      ],
    },
    activeId: id,
  };
}

const nearly = (a: number, b: number) => Math.abs(a - b) < EPS;

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > EPS && h > EPS ? { x, y, w, h } : null;
}

/** f minus its overlap i, as up to four rectangles (strips along `wide` first). */
function subtractRect(f: Rect, i: Rect, wide: boolean): Rect[] {
  const parts: Rect[] = wide
    ? [
        { x: f.x, y: f.y, w: f.w, h: i.y - f.y },
        { x: f.x, y: i.y + i.h, w: f.w, h: f.y + f.h - (i.y + i.h) },
        { x: f.x, y: i.y, w: i.x - f.x, h: i.h },
        { x: i.x + i.w, y: i.y, w: f.x + f.w - (i.x + i.w), h: i.h },
      ]
    : [
        { x: f.x, y: f.y, w: i.x - f.x, h: f.h },
        { x: i.x + i.w, y: f.y, w: f.x + f.w - (i.x + i.w), h: f.h },
        { x: i.x, y: f.y, w: i.w, h: i.y - f.y },
        { x: i.x, y: i.y + i.h, w: i.w, h: f.y + f.h - (i.y + i.h) },
      ];
  return parts.filter((p) => p.w > EPS && p.h > EPS);
}

/** Merges rectangles that share a full edge, until none do. */
function mergeRects(input: Rect[]): Rect[] {
  const rects = [...input];
  for (let again = true; again;) {
    again = false;
    outer: for (let a = 0; a < rects.length; a++)
      for (let b = a + 1; b < rects.length; b++) {
        const p = rects[a];
        const q = rects[b];
        let m: Rect | null = null;
        if (nearly(p.y, q.y) && nearly(p.h, q.h)) {
          if (nearly(p.x + p.w, q.x)) m = { ...p, w: p.w + q.w };
          else if (nearly(q.x + q.w, p.x)) m = { ...q, w: p.w + q.w };
        } else if (nearly(p.x, q.x) && nearly(p.w, q.w)) {
          if (nearly(p.y + p.h, q.y)) m = { ...p, h: p.h + q.h };
          else if (nearly(q.y + q.h, p.y)) m = { ...q, h: p.h + q.h };
        }
        if (m) {
          rects.splice(b, 1);
          rects[a] = m;
          again = true;
          break outer;
        }
      }
  }
  return rects;
}

interface Tile {
  node: LayoutNode;
  rect: Rect;
}

/**
 * Builds a tiling tree whose leaves sit exactly on the given rectangles by
 * recursive straight cuts; null when the tiles cannot be cut that way.
 */
function treeFromTiles(
  tiles: Tile[],
  bounds: Rect,
  first: "row" | "col",
): LayoutNode | null {
  if (tiles.length === 1) return tiles[0].node;
  for (const dir of [first, first === "row" ? "col" : "row"] as const) {
    const lo = (r: Rect) => (dir === "row" ? r.x : r.y);
    const size = (r: Rect) => (dir === "row" ? r.w : r.h);
    const start = lo(bounds);
    const cuts = [...new Set(tiles.map((t) => lo(t.rect) + size(t.rect)))]
      .sort((a, b) => a - b)
      .filter(
        (c) =>
          c > start + EPS &&
          c < start + size(bounds) - EPS &&
          tiles.every(
            (t) =>
              c <= lo(t.rect) + EPS || c >= lo(t.rect) + size(t.rect) - EPS,
          ),
      );
    if (cuts.length === 0) continue;
    const edges = [start, ...cuts, start + size(bounds)];
    const children: LayoutNode[] = [];
    const shares: number[] = [];
    let ok = true;
    for (let k = 0; k + 1 < edges.length && ok; k++) {
      const group = tiles.filter(
        (t) => lo(t.rect) >= edges[k] - EPS && lo(t.rect) < edges[k + 1] - EPS,
      );
      const part: Rect =
        dir === "row"
          ? { ...bounds, x: edges[k], w: edges[k + 1] - edges[k] }
          : { ...bounds, y: edges[k], h: edges[k + 1] - edges[k] };
      const sub = group.length
        ? treeFromTiles(group, part, dir === "row" ? "col" : "row")
        : null;
      if (!sub) ok = false;
      else {
        children.push(sub);
        shares.push((edges[k + 1] - edges[k]) / size(bounds));
      }
    }
    if (!ok) continue;
    const equal = shares.every((s) => nearly(s, 1 / shares.length));
    return equal
      ? { type: "split", dir, children }
      : { type: "split", dir, children, ratios: shares };
  }
  return null;
}

/**
 * Moving pane id into a zone that lies wholly in free space (its own old area
 * plus empty slots): every other pane keeps its exact rectangle, the pane takes
 * the zone and what stays free becomes empty slots. Null when the zone touches
 * another pane or no valid arrangement keeps the others in place.
 */
function dockInFreeSpace(
  layout: Layout,
  id: string,
  zone: WorkspaceZone,
): Layout | null {
  const rects = computeRects(layout.tree);
  const mine = rects.get(id);
  if (!layout.tree || !mine || layout.panes.length < 2) return null;
  const slots = new Set(emptyIds(layout.tree));
  const free: Rect[] = [mine];
  for (const s of slots) free.push(rects.get(s)!);
  const z = zoneRect(zone);
  const parts = free.map((f) => ({ f, i: intersect(f, z) }));
  const covered = parts.reduce((a, p) => a + (p.i ? p.i.w * p.i.h : 0), 0);
  if (!nearly(covered, z.w * z.h)) return null;
  const rootDir = layout.tree.type === "split" ? layout.tree.dir : "row";
  const others: Tile[] = [...rects]
    .filter(([k]) => k !== id && !slots.has(k))
    .map(([k, rect]) => ({ node: leaf(k), rect }));
  for (const wide of [true, false]) {
    const gaps = mergeRects(
      parts.flatMap(({ f, i }) => (i ? subtractRect(f, i, wide) : [f])),
    );
    let seq = layout.seq;
    const reuse = new Map(
      [...slots].map((s) => [s, rects.get(s)!] as [string, Rect]),
    );
    const slotTiles: Tile[] = gaps.map((rect) => {
      for (const [sid, r] of reuse)
        if (
          nearly(r.x, rect.x) &&
          nearly(r.y, rect.y) &&
          nearly(r.w, rect.w) &&
          nearly(r.h, rect.h)
        ) {
          reuse.delete(sid);
          return { node: { type: "empty", id: sid } as LayoutNode, rect };
        }
      return { node: { type: "empty", id: `empty-${seq++}` }, rect };
    });
    const tiles = [...others, ...slotTiles, { node: leaf(id), rect: z }];
    const tree = treeFromTiles(tiles, { x: 0, y: 0, w: 1, h: 1 }, rootDir);
    if (!tree || !isValidTree(tree)) continue;
    const next = computeRects(tree);
    if (
      others.some((t) => {
        const r = next.get((t.node as { id: string }).id);
        return (
          !r ||
          !nearly(r.x, t.rect.x) ||
          !nearly(r.y, t.rect.y) ||
          !nearly(r.w, t.rect.w) ||
          !nearly(r.h, t.rect.h)
        );
      })
    )
      continue;
    return { ...layout, tree, activeId: id, seq };
  }
  return null;
}

/**
 * Re-docks pane id into a half/quarter of the whole workspace. The other
 * panes tile the remaining space; with none left the rest stays empty. Only
 * valid layouts come out (never three in a row or column): a request that
 * would break the rule falls back to a valid arrangement.
 */
export function dockPane(
  layout: Layout,
  id: string,
  zone: WorkspaceZone,
): Layout {
  if (!layout.panes.some((p) => p.id === id)) return layout;
  if (layout.panes.length >= MAX_PANES) return dockIntoGrid(layout, id, zone);
  const inFree = dockInFreeSpace(layout, id, zone);
  if (inFree) return inFree;
  const direct = dockDirect(layout, id, zone);
  if (isValidTree(direct.tree)) return direct;
  // Rebuild the other panes so that they stack across the docked pane.
  const others = readingOrder(
    layout.tree,
    layout.panes.filter((p) => p.id !== id).map((p) => p.id),
  );
  const edge = zone === "left" || zone === "right";
  const rest: LayoutNode =
    others.length === 1
      ? leaf(others[0])
      : {
          type: "split",
          dir: edge ? "col" : "row",
          children: others.map(leaf),
        };
  return dockDirect({ ...layout, tree: rest }, id, zone, true);
}

/** One docking attempt; `rebuilt` says the tree holds only the other panes. */
function dockDirect(
  layout: Layout,
  id: string,
  zone: WorkspaceZone,
  rebuilt = false,
): Layout {
  let seq = layout.seq;
  const slot = (): LayoutNode => ({ type: "empty", id: `empty-${seq++}` });
  const rest =
    (rebuilt ? layout.tree : removeEmpties(removeLeaf(layout.tree, id))) ??
    slot();
  const me = leaf(id);
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
  let tree: LayoutNode;
  switch (zone) {
    case "left":
      tree = row(me, rest);
      break;
    case "right":
      tree = row(rest, me);
      break;
    case "top":
      tree = col(me, rest);
      break;
    case "bottom":
      tree = col(rest, me);
      break;
    case "topLeft":
      tree = col(row(me, slot()), rest);
      break;
    case "topRight":
      tree = col(row(slot(), me), rest);
      break;
    case "bottomLeft":
      tree = col(rest, row(me, slot()));
      break;
    case "bottomRight":
      tree = col(rest, row(slot(), me));
      break;
  }
  return { ...layout, tree, activeId: id, seq };
}

/** What a dragged pane would do at a pointer position. */
export type DropTarget =
  | { kind: "swap"; withId: string }
  | { kind: "slot"; withId: string }
  | { kind: "zone"; zone: WorkspaceZone }
  /**
   * The only pane, dragged past the workspace edge, becomes the single pane
   * covering the whole workspace.
   */
  | { kind: "fill" };

/** Share of an empty slot's width/height, from each side, that counts as its edge. */
const BODY_INSET = 0.25;
/** Thin outer band of the whole workspace that always docks to a zone. */
const EDGE_BAND = 0.12;

/**
 * Resolves a pointer (fractions 0..1 of the workspace) while dragging pane id:
 * anywhere over another pane swaps (layout and ratios stay), the thin outer
 * band of the workspace docks to a half/quarter, an empty slot receives the
 * pane in its body and docks in its edge band (null: nothing to do, e.g. over
 * its own body). A pointer outside the workspace (fractions beyond 0..1) only
 * means something for a lone pane: it then fills the whole workspace.
 */
export function resolveDrop(
  layout: Layout,
  id: string,
  fx: number,
  fy: number,
): DropTarget | null {
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1)
    return layout.panes.length === 1 && layout.panes[0].id === id
      ? { kind: "fill" }
      : null;
  const full = layout.panes.length >= MAX_PANES;
  const zone = (): DropTarget => ({
    kind: "zone",
    zone: full ? quarterAt(fx, fy) : workspaceZoneAt(fx, fy),
  });
  const rects = computeRects(layout.tree);
  const inside = (r: Rect, inset: number) =>
    fx >= r.x + r.w * inset &&
    fx <= r.x + r.w * (1 - inset) &&
    fy >= r.y + r.h * inset &&
    fy <= r.y + r.h * (1 - inset);
  const slots = new Set(emptyIds(layout.tree));
  const band =
    fx < EDGE_BAND ||
    fx > 1 - EDGE_BAND ||
    fy < EDGE_BAND ||
    fy > 1 - EDGE_BAND;
  if (band) return zone();
  for (const [leafId, r] of rects) {
    if (!inside(r, 0)) continue;
    if (slots.has(leafId))
      return inside(r, BODY_INSET) ? { kind: "slot", withId: leafId } : zone();
    if (leafId !== id) return { kind: "swap", withId: leafId };
    if (layout.panes.length > 1 && inside(r, BODY_INSET)) return null;
    return zone();
  }
  return zone();
}

/** Applies a resolved drop. */
export function applyDrop(
  layout: Layout,
  id: string,
  target: DropTarget,
): Layout {
  if (target.kind === "fill") return fillWorkspace(layout, id);
  return target.kind === "zone"
    ? dockPane(layout, id, target.zone)
    : swapPanes(layout, id, target.withId);
}

/** The only pane as a clean single full-size leaf; otherwise unchanged. */
function fillWorkspace(layout: Layout, id: string): Layout {
  if (layout.panes.length !== 1 || layout.panes[0].id !== id) return layout;
  const t = layout.tree;
  if (t && t.type === "pane" && t.id === id && layout.activeId === id)
    return layout;
  return { ...layout, tree: leaf(id), activeId: id };
}

/**
 * The tile to highlight for a drop: only the dragged pane's new place (never
 * the place it leaves or the other pane's new place). `swap` styles swaps.
 */
export function dropPreview(
  layout: Layout,
  id: string,
  target: DropTarget,
): { swap: boolean; rects: Rect[] } {
  const next = computeRects(applyDrop(layout, id, target).tree);
  const mine = next.get(id);
  return {
    swap: target.kind === "swap" || target.kind === "slot",
    rects: mine ? [mine] : [],
  };
}

/**
 * A tree whose leaves are exactly ids and that obeys the layout rules (every
 * id once, unique empty slots, never three in a row or column); anything else
 * falls back to the default grid.
 */
function reconcileTree(
  tree: LayoutNode | null,
  ids: string[],
): LayoutNode | null {
  const have = treeIds(tree);
  if (
    have.length === ids.length &&
    new Set(have).size === have.length &&
    ids.every((i) => have.includes(i)) &&
    new Set(emptyIds(tree)).size === emptyIds(tree).length &&
    !emptyIds(tree).some((e) => have.includes(e)) &&
    isValidTree(tree)
  )
    return tree;
  let out: LayoutNode | null = null;
  for (const id of ids) out = appendLeaf(out, id);
  return out;
}

/** A new pane takes an empty slot if there is one, else the default arrangement. */
function fillTree(
  tree: LayoutNode | null,
  paneId: string,
  emptyId?: string,
): LayoutNode {
  const slots = emptyIds(tree);
  const slot = emptyId && slots.includes(emptyId) ? emptyId : slots[0];
  if (tree && slot) return replaceLeaf(tree, slot, leaf(paneId));
  return appendLeaf(tree, paneId);
}

function makePane(
  layout: Layout,
  containerId: string | null | "local",
  emptyId?: string,
): Layout {
  const id = `pane-${layout.seq}`;
  const pane: Pane =
    containerId === "local"
      ? { id, kind: "local" }
      : { id, kind: "container", containerId };
  return {
    panes: [...layout.panes, pane],
    tree: fillTree(layout.tree, pane.id, emptyId),
    activeId: pane.id,
    seq: layout.seq + 1,
  };
}

/**
 * Applies an action; whatever tree comes out is normalized, so every
 * operation (swap, drop, dock, absorb, ...) leaves a clean structure.
 */
export function layoutReducer(layout: Layout, action: LayoutAction): Layout {
  const next = reduceLayout(layout, action);
  if (next.tree === layout.tree || !next.tree) return next;
  return { ...next, tree: normalize(next.tree) };
}

function reduceLayout(layout: Layout, action: LayoutAction): Layout {
  switch (action.type) {
    case "add":
      return layout.panes.length >= MAX_PANES
        ? layout
        : makePane(layout, action.containerId, action.emptyId);
    case "addLocal": {
      const have = layout.panes.find((p) => p.kind === "local");
      if (have)
        return have.id === layout.activeId
          ? layout
          : { ...layout, activeId: have.id };
      return layout.panes.length >= MAX_PANES
        ? layout
        : makePane(layout, "local", action.emptyId);
    }
    case "open": {
      const existing = layout.panes.find(
        (p) => p.containerId === action.containerId,
      );
      if (existing)
        return existing.id === layout.activeId
          ? layout
          : { ...layout, activeId: existing.id };
      if (layout.panes.length < MAX_PANES)
        return makePane(layout, action.containerId);
      const target =
        layout.panes.find(
          (p) => p.id === layout.activeId && p.kind === "container",
        ) ?? layout.panes.find((p) => p.kind === "container");
      if (!target) return layout;
      return {
        ...layout,
        activeId: target.id,
        panes: layout.panes.map((p) =>
          p.id === target.id && p.kind === "container"
            ? { ...p, containerId: action.containerId }
            : p,
        ),
      };
    }
    case "close": {
      const index = layout.panes.findIndex((p) => p.id === action.id);
      if (index < 0) return layout;
      const panes = layout.panes.filter((p) => p.id !== action.id);
      let activeId = layout.activeId;
      if (activeId === action.id)
        activeId = panes[Math.min(index, panes.length - 1)]?.id ?? null;
      return {
        ...layout,
        panes,
        tree: panes.length > 0 ? removeLeaf(layout.tree, action.id) : null,
        activeId,
      };
    }
    case "resize":
      return {
        ...layout,
        tree: resizeSplit(
          layout.tree,
          action.path,
          action.index,
          action.position,
        ),
      };
    case "resetRatios":
      return { ...layout, tree: resetSplit(layout.tree, action.path) };
    case "absorb":
      return {
        ...layout,
        tree: absorbEmpty(layout.tree, action.path, action.index),
      };
    case "closeEmpty":
      return { ...layout, tree: closeEmptySlot(layout.tree, action.id) };
    case "dock":
      return dockPane(layout, action.id, action.zone);
    case "swap":
      return swapPanes(layout, action.id, action.withId);
    case "drop":
      return applyDrop(layout, action.id, action.target);
    case "setContainer":
      return {
        ...layout,
        panes: layout.panes.map((p) =>
          p.id === action.id && p.kind === "container"
            ? { ...p, containerId: action.containerId }
            : p,
        ),
      };
    case "activate":
      return layout.activeId === action.id ||
        !layout.panes.some((p) => p.id === action.id)
        ? layout
        : { ...layout, activeId: action.id };
    case "prune": {
      const panes = layout.panes.filter(
        (p) =>
          p.kind === "local" ||
          p.containerId === null ||
          action.existing.has(p.containerId),
      );
      if (panes.length === layout.panes.length) return layout;
      const activeId = panes.some((p) => p.id === layout.activeId)
        ? layout.activeId
        : (panes[0]?.id ?? null);
      let tree = layout.tree;
      for (const p of layout.panes)
        if (!panes.includes(p)) tree = removeLeaf(tree, p.id);
      return {
        ...layout,
        panes,
        tree: panes.length > 0 ? tree : null,
        activeId,
      };
    }
  }
}

// ---- persistence --------------------------------------------------------

export function serializeLayout(layout: Layout): string {
  return JSON.stringify({
    panes: layout.panes.map((p) => ({
      id: p.id,
      kind: p.kind,
      ...(p.kind === "container" ? { containerId: p.containerId } : {}),
    })),
    tree: layout.tree,
    activeId: layout.activeId,
    seq: layout.seq,
  });
}

function parseNode(raw: unknown, depth: number): LayoutNode | null {
  if (!raw || typeof raw !== "object" || depth > 8) return null;
  const n = raw as Record<string, unknown>;
  if ((n.type === "pane" || n.type === "empty") && typeof n.id === "string")
    return { type: n.type, id: n.id };
  if (
    n.type === "split" &&
    (n.dir === "row" || n.dir === "col") &&
    Array.isArray(n.children)
  ) {
    const children = n.children
      .map((c) => parseNode(c, depth + 1))
      .filter((c): c is LayoutNode => c !== null);
    const node: LayoutNode = { type: "split", dir: n.dir, children };
    const raw2 = n.ratios;
    if (
      Array.isArray(raw2) &&
      raw2.length === children.length &&
      raw2.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0) &&
      Math.abs((raw2 as number[]).reduce((a, b) => a + b, 0) - 1) < 1e-6
    )
      node.ratios = raw2 as number[];
    return normalize(node);
  }
  return null;
}

/** Tolerant of anything: returns an empty layout for bad input. */
export function parseLayout(raw: string | null | undefined): Layout {
  if (!raw) return emptyLayout();
  try {
    const data = JSON.parse(raw) as Partial<Layout> | null;
    if (!data || !Array.isArray(data.panes)) return emptyLayout();
    const seen = new Set<string>();
    const panes: Pane[] = [];
    for (const p of data.panes as unknown[]) {
      const pane = p as
        (Partial<Omit<ContainerPane, "kind">> & { kind?: string }) | null;
      if (pane && pane.kind === "local" && typeof pane.id === "string") {
        if (seen.has(pane.id) || panes.some((x) => x.kind === "local"))
          continue;
        seen.add(pane.id);
        panes.push({ id: pane.id, kind: "local" });
        if (panes.length >= MAX_PANES) break;
        continue;
      }
      if (
        !pane ||
        pane.kind !== "container" ||
        typeof pane.id !== "string" ||
        seen.has(pane.id) ||
        (pane.containerId !== null && typeof pane.containerId !== "string")
      )
        continue;
      seen.add(pane.id);
      panes.push({
        id: pane.id,
        kind: "container",
        containerId: pane.containerId,
      });
      if (panes.length >= MAX_PANES) break;
    }
    const parsedTree = parseNode(data.tree, 0);
    const maxSeq = [...panes.map((p) => p.id), ...emptyIds(parsedTree)].reduce(
      (n, id) => Math.max(n, Number(id.replace(/\D+/g, "")) || 0),
      0,
    );
    const seq = Math.max(
      typeof data.seq === "number" && Number.isFinite(data.seq) ? data.seq : 1,
      maxSeq + 1,
    );
    const activeId = panes.some((p) => p.id === data.activeId)
      ? (data.activeId as string)
      : (panes[0]?.id ?? null);
    const tree =
      panes.length === 0
        ? null
        : normalize(
            reconcileTree(
              parsedTree,
              panes.map((p) => p.id),
            ),
          );
    return { panes, tree, activeId, seq };
  } catch {
    return emptyLayout();
  }
}

// ---- localStorage (always guarded) --------------------------------------

// The arrangement only survives inside one live session: a new SSH connection
// (new session id) starts from a single pane with the chosen container.
const sessionLayouts = new Map<string, string>();

export function readSessionLayout(sessionId: string): string | null {
  return sessionLayouts.get(sessionId) ?? null;
}

export function writeSessionLayout(sessionId: string, value: string): void {
  sessionLayouts.set(sessionId, value);
}

export function paneStateKey(
  hostId: number | string,
  containerId: string,
): string {
  return `container-files.pane.${hostId}.${containerId}`;
}

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // private mode, quota, blocked storage: the workspace still works
  }
}

/**
 * Per-pane view state (view mode, sorting). The folder is deliberately not
 * remembered: every container opens at "/".
 */
export interface PaneViewState {
  viewMode?: "grid" | "list";
  density?: "comfortable" | "compact";
  sortBy?: "name" | "modified" | "size";
  sortOrder?: "asc" | "desc";
}

export function parsePaneState(raw: string | null): PaneViewState {
  if (!raw) return {};
  try {
    const d = JSON.parse(raw) as Record<string, unknown> | null;
    if (!d || typeof d !== "object") return {};
    const out: PaneViewState = {};
    if (d.viewMode === "grid" || d.viewMode === "list")
      out.viewMode = d.viewMode;
    if (d.density === "comfortable" || d.density === "compact")
      out.density = d.density;
    if (d.sortBy === "name" || d.sortBy === "modified" || d.sortBy === "size")
      out.sortBy = d.sortBy;
    if (d.sortOrder === "asc" || d.sortOrder === "desc")
      out.sortOrder = d.sortOrder;
    return out;
  } catch {
    return {};
  }
}

// Pure helpers of the folder-tree sidebar (no React, no network).
import type { FileItem } from "./vendor/file-manager/host-types";

/** Most folders shown under one node before a "more..." row. */
export const TREE_NODE_CAP = 500;

/** What the tree reads of a listed entry (a `FileItem` fits). */
export type TreeEntry = Pick<FileItem, "name" | "path" | "type" | "linkTarget">;

export interface TreeDir {
  name: string;
  path: string;
  /** True when the folder is a symlink pointing at a folder. */
  link: boolean;
}

export interface TreeNode {
  status: "loading" | "loaded" | "error";
  dirs: TreeDir[];
  /** More folders exist than the cap allows. */
  more: boolean;
  error?: string;
}

export type TreeNodes = Record<string, TreeNode>;

/** "/a/b" -> ["/", "/a", "/a/b"]; the ancestors a path needs expanded. */
export function expansionChain(path: string): string[] {
  const chain = ["/"];
  let acc = "";
  for (const part of path.split("/").filter(Boolean)) {
    acc += `/${part}`;
    chain.push(acc);
  }
  return chain;
}

const byName = (a: TreeDir, b: TreeDir): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true });

/** Folders of a listing chunk (links to folders included, marked). */
export function directoriesOnly(files: readonly TreeEntry[]): TreeDir[] {
  return files
    .filter((f) => f.type === "directory")
    .map((f) => ({
      name: f.name,
      path: f.path,
      link: f.linkTarget !== undefined,
    }));
}

/** Adds freshly listed folders to a node: unique, sorted, capped. */
export function mergeChildren(
  existing: readonly TreeDir[],
  incoming: readonly TreeDir[],
  cap = TREE_NODE_CAP,
): { dirs: TreeDir[]; more: boolean } {
  const seen = new Set(existing.map((d) => d.path));
  const merged = [...existing];
  for (const d of incoming) {
    if (!seen.has(d.path)) {
      seen.add(d.path);
      merged.push(d);
    }
  }
  merged.sort(byName);
  return { dirs: merged.slice(0, cap), more: merged.length > cap };
}

/** Whether `path` is `ancestor` or lies below it. */
export function isWithin(path: string, ancestor: string): boolean {
  return (
    ancestor === "/" || path === ancestor || path.startsWith(`${ancestor}/`)
  );
}

/**
 * The nodes worth keeping when the listings are reloaded: the expanded ones,
 * which are reloaded right away. A collapsed node would otherwise keep its old
 * children and show them stale when it is opened again.
 */
export function keepExpanded(
  nodes: TreeNodes,
  expanded: ReadonlySet<string>,
): TreeNodes {
  const kept: TreeNodes = {};
  for (const [path, node] of Object.entries(nodes))
    if (expanded.has(path)) kept[path] = node;
  return kept;
}

import React from "react";
import { listFiles } from "./containerFsApi";
import {
  TREE_NODE_CAP,
  directoriesOnly,
  expansionChain,
  mergeChildren,
  type TreeDir,
  type TreeEntry,
  type TreeNodes,
} from "./folderTree";

export const TREE_MIN = 140;
export const TREE_MAX = 480;

/** Lists one folder, delivering entries through `onChunk` (as `listFiles`). */
export type TreeSource = (
  path: string,
  options: {
    signal: AbortSignal;
    onChunk: (entries: readonly TreeEntry[]) => void;
  },
) => Promise<unknown>;

export interface FolderTreeOptions {
  /** Where folders come from; default: the container's `listFiles`. */
  source?: TreeSource;
  /** Ancestors a location needs expanded; default: POSIX chain from "/". */
  chain?: (path: string) => string[];
  /** Prefix of the remembered open flag and width. */
  storagePrefix?: string;
  /** Nodes expanded at the start; default: the root "/". */
  initialExpanded?: readonly string[];
}

function readWidth(widthKey: string): number {
  try {
    const n = Number(localStorage.getItem(widthKey));
    return Number.isFinite(n) && n >= TREE_MIN && n <= TREE_MAX ? n : 220;
  } catch {
    return 220;
  }
}

/**
 * State of one pane's folder tree: open flag and width (remembered), lazily
 * loaded children per path, and the expanded set that follows `currentPath`.
 */
export function useFolderTree(
  key: string,
  currentPath: string,
  active: boolean,
  options: FolderTreeOptions = {},
) {
  const prefix = options.storagePrefix ?? "containerFiles";
  const WIDTH_KEY = `${prefix}.treeWidth`;
  const OPEN_KEY = `${prefix}.treeOpen`;
  // Held in refs so `load` keeps its identity when the caller passes new closures.
  const sourceRef = React.useRef(options.source);
  sourceRef.current = options.source;
  const chainRef = React.useRef(options.chain ?? expansionChain);
  chainRef.current = options.chain ?? expansionChain;

  const [open, setOpenState] = React.useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [width, setWidthState] = React.useState(() => readWidth(WIDTH_KEY));
  const [nodes, setNodes] = React.useState<TreeNodes>({});
  const [expanded, setExpanded] = React.useState<Set<string>>(
    () => new Set(options.initialExpanded ?? ["/"]),
  );
  const aborts = React.useRef(new Map<string, AbortController>());
  const nodesRef = React.useRef(nodes);
  nodesRef.current = nodes;

  const setOpen = (value: boolean) => {
    setOpenState(value);
    try {
      localStorage.setItem(OPEN_KEY, value ? "1" : "0");
    } catch {
      /* not remembered */
    }
  };
  const setWidth = (value: number, persist = true) => {
    const w = Math.max(TREE_MIN, Math.min(TREE_MAX, Math.round(value)));
    setWidthState(w);
    if (!persist) return;
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      /* not remembered */
    }
  };

  const load = React.useCallback(
    async (path: string) => {
      aborts.current.get(path)?.abort();
      const controller = new AbortController();
      aborts.current.set(path, controller);
      const previous = nodesRef.current[path];
      setNodes((n) => ({
        ...n,
        [path]: {
          status: "loading",
          dirs: previous?.dirs ?? [],
          more: previous?.more ?? false,
        },
      }));
      let dirs: TreeDir[] = [];
      let more = false;
      try {
        const list: TreeSource =
          sourceRef.current ??
          ((p, o) => listFiles(key, p, o as Parameters<typeof listFiles>[2]));
        await list(path, {
          signal: controller.signal,
          onChunk: (chunk) => {
            const merged = mergeChildren(dirs, directoriesOnly(chunk));
            dirs = merged.dirs;
            if (merged.more) {
              more = true;
              controller.abort(); // never read a huge listing to the end
            }
          },
        });
      } catch (error) {
        if (!more) {
          if (aborts.current.get(path) !== controller) return; // superseded
          setNodes((n) => ({
            ...n,
            [path]: {
              status: "error",
              dirs: [],
              more: false,
              error: error instanceof Error ? error.message : String(error),
            },
          }));
          return;
        }
      }
      if (aborts.current.get(path) !== controller) return;
      setNodes((n) => ({
        ...n,
        [path]: { status: "loaded", dirs: dirs.slice(0, TREE_NODE_CAP), more },
      }));
    },
    [key],
  );

  // Follow the current location: expand its ancestors, load what is missing.
  React.useEffect(() => {
    if (!active || !open) return;
    const chain = chainRef.current(currentPath);
    setExpanded((prev) =>
      chain.every((p) => prev.has(p)) ? prev : new Set([...prev, ...chain]),
    );
    for (const p of chain) if (!nodesRef.current[p]) void load(p);
  }, [currentPath, active, open, load]);

  React.useEffect(() => {
    const map = aborts.current;
    return () => map.forEach((c) => c.abort());
  }, []);

  const toggle = (path: string) => {
    const isOpen = expanded.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!isOpen && !nodesRef.current[path]) void load(path);
  };

  /** Reloads every expanded node (after a mutation). */
  const refresh = () => {
    for (const p of expanded) void load(p);
  };

  return {
    open,
    setOpen,
    width,
    setWidth,
    nodes,
    expanded,
    toggle,
    load,
    refresh,
  };
}

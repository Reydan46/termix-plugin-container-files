import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { copyToClipboard } from "@termix-ssh/plugin-sdk/ui";
import { Download, Laptop } from "lucide-react";
import { toast } from "sonner";
import { ContainerFolderTree } from "./ContainerFolderTree";
import { LocalFileList, type InlineEdit } from "./LocalFileList";
import { LocalToolbar, SHORTCUT_ICONS, rootLabel } from "./LocalToolbar";
import { getLocalKnownFolders } from "./localKnownFolders";
import { isActivePane } from "./paneFocus";
import {
  parseViewPrefs,
  serializeViewPrefs,
  type LocalDensity,
  type LocalViewMode,
} from "./localViewPrefs";
import { useFolderTree } from "./useFolderTree";
import { useConfirm } from "./popup/useConfirm";
import { parseInternalFiles } from "./workspace/dragRegistry";
import type { TreeEntry } from "./folderTree";
import {
  THIS_PC,
  createDriveProbe,
  isWindowsPath,
  localExpansionChain,
  normalizeTypedPath,
  pathKey,
  rememberRoot,
  resolveShortcuts,
  rootOf,
  upTarget,
  type DriveProbe,
  type LocalShortcut,
} from "./localPathUtils";
import type {
  LocalFileEntry,
  LocalFsHomeInfo,
} from "./vendor/file-manager/local-types";
import {
  createLocalFile,
  createLocalFolder,
  getLocalHome,
  listLocalDirectory,
  localPathsExist,
  openLocalPath,
  renameLocalEntry,
  revealLocalPath,
  trashLocalPaths,
} from "./vendor/file-manager/lib/local-files";
import { LocalFileContextMenu } from "./vendor/file-manager/LocalFileContextMenu";
import {
  LOCAL_FILES_DRAG_MIME,
  isRemoteFilesDrag,
  parseInternalFilesDragPayload,
  serializeLocalFilesDragPayload,
  sortLocalEntries,
  type LocalSortField,
} from "./vendor/file-manager/local-transfer-utils";

const LAST_PATH_KEY = "termix:file-manager:local-pane:path";
const HIDDEN_KEY = "termix:file-manager:local-pane:hidden";
const VIEW_KEY = "termix:file-manager:local-pane:view";
const RECENT_ROOTS_KEY = "termix:file-manager:local-pane:recent-roots";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not remembered */
  }
}

function readRecents(): string[] {
  try {
    const parsed = JSON.parse(readStored(RECENT_ROOTS_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((r): r is string => typeof r === "string").slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

const toTreeEntry = (e: LocalFileEntry): TreeEntry => ({
  name: e.name,
  path: e.path,
  type:
    e.type === "directory" ? "directory" : e.type === "link" ? "link" : "file",
  linkTarget: e.linkTarget,
});

function driveEntry(root: string): LocalFileEntry {
  return {
    name: root,
    path: root,
    type: "directory",
    size: 0,
    hidden: false,
  };
}

type DropTarget = { kind: "pane" } | { kind: "folder"; path: string } | null;

export interface LocalFileManagerProps {
  /** Bump to force a re-read of the current directory. */
  refreshToken?: number;
  onClose?: () => void;
  /**
   * Remote grid items were dropped on this pane (or on one of its folders).
   * `remotePaths` are the dragged remote paths; `localDir` is where they go.
   */
  onRemoteItemsDropped: (remotePaths: string[], localDir: string) => void;
  /** "Upload to server": sends local paths to the other pane's folder. */
  onUploadToRemote?: (localPaths: string[]) => void;
  onPathChange?: (localPath: string) => void;
}

/**
 * Browser of this computer's disk. Same look and controls as the container
 * pane (path bar, folder tree, toolbar, sortable columns), plus a drive and
 * quick-access picker. Drag and drop to and from container panes is the
 * contract of the old local pane, unchanged.
 */
export function LocalFileManager({
  refreshToken,
  onClose,
  onRemoteItemsDropped,
  onUploadToRemote,
  onPathChange,
}: LocalFileManagerProps): React.ReactElement {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm(t("local.pane"), rootRef);

  const [home, setHome] = useState<LocalFsHomeInfo | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<LocalFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<LocalSortField>("name");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [showHidden, setShowHiddenState] = useState(
    () => readStored(HIDDEN_KEY) !== "false",
  );
  const [viewPrefs, setViewPrefs] = useState(() =>
    parseViewPrefs(readStored(VIEW_KEY)),
  );
  const updateViewPrefs = (patch: {
    viewMode?: LocalViewMode;
    density?: LocalDensity;
  }) => {
    const next = { ...viewPrefs, ...patch };
    setViewPrefs(next);
    writeStored(VIEW_KEY, serializeViewPrefs(next));
  };
  const [nav, setNav] = useState({ canBack: false, canForward: false });
  const [edit, setEditState] = useState<InlineEdit | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entries: LocalFileEntry[];
    visible: boolean;
  }>({ x: 0, y: 0, entries: [], visible: false });
  const [recents, setRecents] = useState<string[]>(readRecents);
  const [drives, setDrives] = useState<string[] | null>(null);
  const [shortcuts, setShortcuts] = useState<LocalShortcut[]>([]);

  const windows = home ? home.separator === "\\" : false;
  const drivesMode = currentPath === THIS_PC;

  // Refs the async code and the document listeners read the latest values from.
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const loadSeq = useRef(0);
  const pathRef = useRef("");
  const editRef = useRef<InlineEdit | null>(null);
  const dragCounter = useRef(0);
  const lastRefreshToken = useRef(refreshToken);
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;
  const recentsRef = useRef(recents);
  recentsRef.current = recents;
  const onPathChangeRef = useRef(onPathChange);
  onPathChangeRef.current = onPathChange;
  const homeRef = useRef(home);
  homeRef.current = home;

  const setEdit = (value: InlineEdit | null) => {
    editRef.current = value;
    setEditState(value);
  };

  // ------------------------------------------------------------- drives ---

  const probeRef = useRef<DriveProbe | null>(null);
  if (probeRef.current === null) {
    probeRef.current = createDriveProbe(localPathsExist, {
      known: () => {
        const roots = [...recentsRef.current];
        const homeRoot = homeRef.current ? rootOf(homeRef.current.home) : null;
        if (homeRoot) roots.push(homeRoot);
        const here = pathRef.current;
        const hereRoot = here && here !== THIS_PC ? rootOf(here) : null;
        if (hereRoot) roots.push(hereRoot);
        return roots.filter(isWindowsPath);
      },
    });
  }
  const probe = probeRef.current;

  const refreshDrives = useCallback(
    async (force = false): Promise<string[]> => {
      const roots = await probe.get(force);
      setDrives(roots);
      return roots;
    },
    [probe],
  );

  // ------------------------------------------------------------ loading ---

  /** Reads a location; resolves with the path shown, or null on failure. */
  const load = useCallback(
    async (target: string, force = false): Promise<string | null> => {
      const seq = ++loadSeq.current;
      setLoading(true);
      try {
        let shown = target;
        let list: LocalFileEntry[];
        if (target === THIS_PC) {
          list = (await refreshDrives(force)).map(driveEntry);
        } else {
          const listing = await listLocalDirectory(target);
          shown = listing.path || target;
          list = listing.entries;
        }
        if (seq !== loadSeq.current) return null;
        const changed = pathRef.current !== shown;
        pathRef.current = shown;
        setCurrentPath(shown);
        setEntries(list);
        setError(null);
        setSelected(new Set());
        setAnchorPath(null);
        if (changed) setSearch("");
        if (shown !== THIS_PC) {
          writeStored(LAST_PATH_KEY, shown);
          onPathChangeRef.current?.(shown);
          const root = rootOf(shown);
          if (root && isWindowsPath(shown)) {
            setRecents((prev) => {
              const next = rememberRoot(prev, shown);
              if (next.join("|") === prev.join("|")) return prev;
              writeStored(RECENT_ROOTS_KEY, JSON.stringify(next));
              return next;
            });
          }
        }
        return shown;
      } catch (err) {
        if (seq !== loadSeq.current) return null;
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [refreshDrives],
  );

  const syncNav = () =>
    setNav({
      canBack: historyIndexRef.current > 0,
      canForward: historyIndexRef.current < historyRef.current.length - 1,
    });

  const navigateTo = useCallback(
    async (target: string, record = true) => {
      if (!target) return;
      const shown = await load(target);
      if (shown === null || !record) return;
      const history = historyRef.current.slice(0, historyIndexRef.current + 1);
      if (history[history.length - 1] !== shown) history.push(shown);
      historyRef.current = history;
      historyIndexRef.current = history.length - 1;
      syncNav();
    },
    [load],
  );

  const goHistory = (delta: number) => {
    const index = historyIndexRef.current + delta;
    const target = historyRef.current[index];
    if (target === undefined) return;
    // The position moves only once the folder really opened.
    void load(target).then((shown) => {
      if (shown === null) return;
      historyIndexRef.current = index;
      syncNav();
    });
  };

  const refresh = (force = false) => {
    const target = pathRef.current;
    if (target) void load(target, force);
    tree.refresh();
  };

  const goHome = () => {
    if (homeRef.current) void navigateTo(homeRef.current.home);
  };

  // First load: the remembered folder, or the home folder.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await getLocalHome();
        if (cancelled) return;
        setHome(info);
        homeRef.current = info;
        const stored = readStored(LAST_PATH_KEY);
        let shown = stored ? await load(stored) : null;
        if (shown === null && !cancelled) shown = await load(info.home);
        if (shown !== null && !cancelled) {
          historyRef.current = [shown];
          historyIndexRef.current = 0;
          syncNav();
        }
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Quick access and (on Windows) the drives list, once the home is known.
  useEffect(() => {
    if (!home) return;
    let cancelled = false;
    setShortcuts([{ id: "home", path: home.home }]);
    void getLocalKnownFolders()
      .then((known) =>
        resolveShortcuts(home.home, home.separator, localPathsExist, known),
      )
      .then((found) => !cancelled && setShortcuts(found))
      .catch(() => undefined);
    if (home.separator === "\\") void refreshDrives().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [home, refreshDrives]);

  useEffect(() => {
    if (refreshToken === lastRefreshToken.current) return;
    lastRefreshToken.current = refreshToken;
    if (pathRef.current) void load(pathRef.current);
  }, [refreshToken, load]);

  // --------------------------------------------------------------- tree ---

  const tree = useFolderTree("local", currentPath, home !== null, {
    source: async (path, { onChunk }) => {
      const listing = await listLocalDirectory(path);
      onChunk(
        listing.entries
          .filter((e) => showHiddenRef.current || !e.hidden)
          .map(toTreeEntry),
      );
    },
    chain: localExpansionChain,
    storagePrefix: "localFiles.tree",
    initialExpanded: [],
  });

  const treeRoots = useMemo(() => {
    if (!windows) return [{ path: "/", label: "/" }];
    const here = currentPath && !drivesMode ? rootOf(currentPath) : null;
    const roots = drives ?? (here ? [here] : []);
    return roots.map((r) => ({ path: r, label: rootLabel(r) }));
  }, [windows, drives, currentPath, drivesMode]);

  const setShowHidden = (value: boolean) => {
    setShowHiddenState(value);
    showHiddenRef.current = value;
    writeStored(HIDDEN_KEY, value ? "true" : "false");
    tree.refresh();
  };

  // ---------------------------------------------------------- the entries ---

  const visibleEntries = useMemo(() => {
    let list = entries;
    if (!drivesMode && !showHidden) list = list.filter((e) => !e.hidden);
    const needle = search.trim().toLowerCase();
    if (needle)
      list = list.filter((e) => e.name.toLowerCase().includes(needle));
    return sortLocalEntries(list, sortBy, sortOrder);
  }, [entries, drivesMode, showHidden, search, sortBy, sortOrder]);

  const selectedEntries = () =>
    visibleEntries.filter((e) => selected.has(e.path));

  const toggleSort = (field: LocalSortField) => {
    if (field === sortBy) setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    else {
      setSortBy(field);
      setSortOrder("asc");
    }
  };

  const openEntry = (entry: LocalFileEntry) => {
    if (entry.type === "directory") {
      void navigateTo(entry.path);
    } else {
      void openLocalPath(entry.path).catch(() => {
        void revealLocalPath(entry.path);
      });
    }
  };

  const handleRowClick = (entry: LocalFileEntry, event: React.MouseEvent) => {
    if (event.detail === 2) {
      openEntry(entry);
      return;
    }
    if (event.shiftKey && anchorPath) {
      const from = visibleEntries.findIndex((e) => e.path === anchorPath);
      const to = visibleEntries.findIndex((e) => e.path === entry.path);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelected(
          new Set(visibleEntries.slice(lo, hi + 1).map((e) => e.path)),
        );
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
    } else {
      setSelected(new Set([entry.path]));
    }
    setAnchorPath(entry.path);
  };

  // ----------------------------------------------------------- mutations ---

  const reportError = (err: unknown, fallbackKey: string) => {
    const message = err instanceof Error ? err.message : String(err ?? "");
    toast.error(t(fallbackKey), message ? { description: message } : undefined);
  };

  const startCreate = (kind: "folder" | "file") => {
    if (drivesMode || !pathRef.current) return;
    setEdit({ kind, name: "" });
  };

  const startRename = (entry: LocalFileEntry) => {
    if (drivesMode) return;
    setEdit({ path: entry.path, name: entry.name });
  };

  const submitEdit = async () => {
    const current = editRef.current;
    setEdit(null);
    const dir = pathRef.current;
    if (!current || !dir) return;
    const name = current.name.trim();
    if (!name) return;
    if (current.kind) {
      try {
        if (current.kind === "folder") await createLocalFolder(dir, name);
        else await createLocalFile(dir, name);
        if (pathRef.current === dir) await load(dir);
        tree.refresh();
      } catch (err) {
        reportError(err, "fileManager.localCreateFailed");
      }
      return;
    }
    const entry = entries.find((e) => e.path === current.path);
    if (!entry || name === entry.name) return;
    try {
      await renameLocalEntry(entry.path, name);
      if (pathRef.current === dir) await load(dir);
      tree.refresh();
    } catch (err) {
      reportError(err, "fileManager.localRenameFailed");
    }
  };

  const copyEntryPaths = (targets: LocalFileEntry[]) => {
    if (targets.length === 0) return;
    void copyToClipboard(targets.map((e) => e.path).join("\n")).then((ok) => {
      if (ok) {
        toast.success(
          targets.length === 1
            ? t("fileManager.pathCopiedToClipboard")
            : t("fileManager.pathsCopiedToClipboard", {
                count: targets.length,
              }),
        );
      } else {
        toast.error(t("fileManager.failedToCopyPath"));
      }
    });
  };

  const trashEntries = (targets: LocalFileEntry[]) => {
    const dir = pathRef.current;
    if (targets.length === 0 || !dir || drivesMode) return;
    const hasDirectory = targets.some((e) => e.type === "directory");
    const title =
      targets.length === 1
        ? t(
            hasDirectory
              ? "fileManager.localTrashConfirmFolder"
              : "fileManager.localTrashConfirmSingle",
            { name: targets[0].name },
          )
        : t("fileManager.localTrashConfirmMany", { count: targets.length });
    void confirm({ title }).then((ok) => {
      if (!ok) return;
      void (async () => {
        try {
          const result = await trashLocalPaths(targets.map((e) => e.path));
          if (result.failed.length === 0) {
            toast.success(
              t("fileManager.localTrashed", { count: result.trashed }),
            );
          } else {
            toast.error(t("fileManager.localTrashFailed"), {
              description: result.failed
                .map((f) => `${f.path}: ${f.error}`)
                .join("\n"),
            });
          }
        } catch (err) {
          reportError(err, "fileManager.localTrashFailed");
        }
        if (pathRef.current === dir) await load(dir);
        tree.refresh();
      })();
    });
  };

  const uploadSelected = () => {
    const paths = selectedEntries().map((e) => e.path);
    if (paths.length > 0) onUploadToRemote?.(paths);
  };

  const revealHere = () => {
    const target = pathRef.current;
    if (target && target !== THIS_PC) void revealLocalPath(target);
  };

  // --------------------------------------------------------- context menu ---

  const closeContextMenu = useCallback(
    () => setContextMenu((m) => ({ ...m, visible: false })),
    [],
  );

  const openContextMenu = (event: React.MouseEvent, entry?: LocalFileEntry) => {
    event.preventDefault();
    event.stopPropagation();
    let targets: LocalFileEntry[] = [];
    if (entry) {
      if (selected.has(entry.path)) {
        targets = selectedEntries();
      } else {
        setSelected(new Set([entry.path]));
        setAnchorPath(entry.path);
        targets = [entry];
      }
    }
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      entries: targets,
      visible: true,
    });
  };

  // ----------------------------------------------------------- drag & drop ---

  const handleRowDragStart = (
    event: React.DragEvent,
    entry: LocalFileEntry,
  ) => {
    const paths = selected.has(entry.path)
      ? Array.from(selected)
      : [entry.path];
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
      setAnchorPath(entry.path);
    }
    const payload = serializeLocalFilesDragPayload(paths);
    event.dataTransfer.setData(LOCAL_FILES_DRAG_MIME, payload);
    event.dataTransfer.setData("text/plain", payload);
    event.dataTransfer.effectAllowed = "copy";
  };

  /** Nothing can be dropped on the drives list itself. */
  const canDrop = !drivesMode;

  const handlePaneDragEnter = (event: React.DragEvent) => {
    if (!canDrop || !isRemoteFilesDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragCounter.current += 1;
    setDropTarget((prev) => prev ?? { kind: "pane" });
  };

  const handlePaneDragOver = (event: React.DragEvent) => {
    if (!canDrop || !isRemoteFilesDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handlePaneDragLeave = (event: React.DragEvent) => {
    if (!canDrop || !isRemoteFilesDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setDropTarget(null);
  };

  const finishDrop = (event: React.DragEvent, localDir: string | null) => {
    const remotePaths = parseInternalFilesDragPayload(
      event.dataTransfer.getData("text/plain"),
    );
    dragCounter.current = 0;
    setDropTarget(null);
    if (!remotePaths || !localDir || localDir === THIS_PC) return;
    onRemoteItemsDropped(remotePaths, localDir);
  };

  const handlePaneDrop = (event: React.DragEvent) => {
    if (!canDrop || !isRemoteFilesDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    finishDrop(event, pathRef.current);
  };

  const folderDropAllowed = (event: React.DragEvent, entry: LocalFileEntry) =>
    entry.type === "directory" &&
    entry.path !== THIS_PC &&
    isRemoteFilesDrag(event.dataTransfer);

  const handleFolderDragOver = (
    event: React.DragEvent,
    entry: LocalFileEntry,
  ) => {
    if (!folderDropAllowed(event, entry)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDropTarget((prev) =>
      prev?.kind === "folder" && prev.path === entry.path
        ? prev
        : { kind: "folder", path: entry.path },
    );
  };

  const handleFolderDragLeave = (
    event: React.DragEvent,
    entry: LocalFileEntry,
  ) => {
    if (!folderDropAllowed(event, entry)) return;
    event.stopPropagation();
    setDropTarget((prev) =>
      prev?.kind === "folder" && prev.path === entry.path
        ? { kind: "pane" }
        : prev,
    );
  };

  const handleFolderDrop = (event: React.DragEvent, entry: LocalFileEntry) => {
    if (!folderDropAllowed(event, entry)) return;
    event.preventDefault();
    event.stopPropagation();
    finishDrop(event, entry.path);
  };

  // ------------------------------------------------------------ keyboard ---

  const upPath = currentPath ? upTarget(currentPath) : null;

  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || contextMenu.visible) return;
    if (!isActivePane(rootRef.current)) return;
    const target = event.target as Element | null;
    if (
      target?.closest?.(
        'input, textarea, [contenteditable="true"], [role="dialog"], [role="alertdialog"], [role="menu"]',
      )
    )
      return;
    const mod = event.ctrlKey || event.metaKey;
    const picked = selectedEntries();

    if (event.altKey && !mod) {
      if (event.key === "ArrowLeft") goHistory(-1);
      else if (event.key === "ArrowRight") goHistory(1);
      else if (event.key === "ArrowUp" && upPath !== null)
        void navigateTo(upPath);
      else return;
      event.preventDefault();
      return;
    }
    switch (event.key) {
      case "Enter":
        if (picked.length === 1) {
          event.preventDefault();
          openEntry(picked[0]);
        }
        break;
      case "F2":
        if (picked.length === 1 && !drivesMode) {
          event.preventDefault();
          startRename(picked[0]);
        }
        break;
      case "Delete":
        if (picked.length > 0 && !drivesMode) {
          event.preventDefault();
          trashEntries(picked);
        }
        break;
      case "Backspace":
        if (mod && picked.length > 0 && !drivesMode) {
          event.preventDefault();
          trashEntries(picked);
        }
        break;
      case "F5":
        event.preventDefault();
        refresh(true);
        break;
      case "Escape":
        if (selected.size > 0) {
          event.preventDefault();
          setSelected(new Set());
        }
        break;
      case "a":
      case "A":
        if (mod && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          setSelected(new Set(visibleEntries.map((e) => e.path)));
        }
        break;
    }
  };
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => onKeyRef.current(event);
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // --------------------------------------------------------------- render ---

  const navigateTyped = (text: string) => {
    if (!home) return;
    const path = normalizeTypedPath(text, home.home, home.separator);
    if (!path) return;
    if (path === THIS_PC && !windows) return;
    void navigateTo(path);
  };

  const quickAccess = (
    <div className="shrink-0 border-b border-border py-1">
      <p className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
        {t("localFiles.quickAccess")}
      </p>
      {windows && (
        <button
          type="button"
          onClick={() => void navigateTo(THIS_PC)}
          className={`flex w-full items-center gap-2 px-2 py-0.5 text-left text-xs hover:bg-muted/40 ${
            drivesMode
              ? "bg-accent-brand/15 text-foreground"
              : "text-muted-foreground"
          }`}
        >
          <Laptop className="size-3.5 shrink-0" />
          <span className="truncate">{t("localFiles.thisPc")}</span>
        </button>
      )}
      {shortcuts.map((s) => {
        const Icon = SHORTCUT_ICONS[s.id];
        const here =
          currentPath !== "" && pathKey(currentPath) === pathKey(s.path);
        return (
          <button
            key={s.id}
            type="button"
            title={s.path}
            onClick={() => void navigateTo(s.path)}
            className={`flex w-full items-center gap-2 px-2 py-0.5 text-left text-xs hover:bg-muted/40 ${
              here
                ? "bg-accent-brand/15 text-foreground"
                : "text-muted-foreground"
            }`}
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="truncate">{t(`localFiles.place.${s.id}`)}</span>
          </button>
        );
      })}
    </div>
  );

  const dropPath = dropTarget?.kind === "folder" ? dropTarget.path : null;

  return (
    <div
      ref={rootRef}
      data-fm-pane=""
      data-testid="local-file-pane"
      className="relative h-full min-h-0 w-full flex-1"
      onDragEnter={handlePaneDragEnter}
      onDragOver={handlePaneDragOver}
      onDragLeave={handlePaneDragLeave}
      onDrop={handlePaneDrop}
    >
      <div className="absolute inset-0 flex flex-col overflow-hidden bg-background">
        <LocalToolbar
          currentPath={currentPath}
          places={{
            windows,
            drives,
            shortcuts,
            recents,
            onOpen: () => void refreshDrives().catch(() => undefined),
          }}
          loading={loading}
          canBack={nav.canBack}
          canForward={nav.canForward}
          canUp={upPath !== null}
          sidebarOpen={tree.open}
          onToggleSidebar={() => tree.setOpen(!tree.open)}
          onBack={() => goHistory(-1)}
          onForward={() => goHistory(1)}
          onUp={() => upPath !== null && void navigateTo(upPath)}
          onRefresh={() => refresh(true)}
          onNavigate={(p) => void navigateTo(p)}
          onNavigateTyped={navigateTyped}
          selectedCount={drivesMode ? 0 : selected.size}
          onDeleteSelected={() => trashEntries(selectedEntries())}
          onCopySelected={() => copyEntryPaths(selectedEntries())}
          onUploadSelected={onUploadToRemote ? uploadSelected : undefined}
          search={search}
          onSearch={setSearch}
          sortBy={sortBy}
          sortOrder={sortOrder}
          onSortBy={setSortBy}
          onSortOrder={setSortOrder}
          canCreate={!drivesMode && currentPath !== "" && !error}
          onNewFolder={() => startCreate("folder")}
          onNewFile={() => startCreate("file")}
          showHidden={showHidden}
          onToggleHidden={() => setShowHidden(!showHidden)}
          onReveal={revealHere}
          viewMode={viewPrefs.viewMode}
          onViewMode={(viewMode) => updateViewPrefs({ viewMode })}
          density={viewPrefs.density}
          onDensity={(density) => updateViewPrefs({ density })}
          onClose={onClose}
        />

        <div className="flex min-h-0 flex-1">
          {tree.open && home && (
            <ContainerFolderTree
              nodes={tree.nodes}
              expanded={tree.expanded}
              currentPath={currentPath}
              width={tree.width}
              onWidth={tree.setWidth}
              onToggle={tree.toggle}
              onLoad={(p) => void tree.load(p)}
              onNavigate={(p) => void navigateTo(p)}
              parsePaths={parseInternalFiles}
              onDropPaths={(paths, dest) => onRemoteItemsDropped(paths, dest)}
              roots={treeRoots}
              header={quickAccess}
              dropEffect="copy"
            />
          )}
          <LocalFileList
            entries={visibleEntries}
            drivesMode={drivesMode}
            parentPath={upPath}
            selected={selected}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onToggleSort={toggleSort}
            loading={loading}
            error={error}
            onHome={goHome}
            filtered={search.trim() !== ""}
            edit={edit}
            onEditChange={(name) =>
              setEdit(editRef.current ? { ...editRef.current, name } : null)
            }
            onEditSubmit={() => void submitEdit()}
            onEditCancel={() => setEdit(null)}
            dropPath={dropPath}
            onRowClick={handleRowClick}
            onRowContextMenu={openContextMenu}
            onRowDragStart={handleRowDragStart}
            onFolderDragOver={handleFolderDragOver}
            onFolderDragLeave={handleFolderDragLeave}
            onFolderDrop={handleFolderDrop}
            onGoUp={() => upPath !== null && void navigateTo(upPath)}
            onBackgroundClick={() => setSelected(new Set())}
            viewMode={viewPrefs.viewMode}
            density={viewPrefs.density}
          />
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-1 border-t border-border text-xs text-muted-foreground">
          <span>
            {t("fileManager.localItemCount", { count: visibleEntries.length })}
          </span>
          {selected.size > 0 && !drivesMode && (
            <span>
              {t("fileManager.localSelectedCount", { count: selected.size })}
            </span>
          )}
        </div>
      </div>

      {/* Sits outside the scrolling list so it stays put while the list scrolls. */}
      {dropTarget?.kind === "pane" && canDrop && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/50 border-2 border-dashed border-primary pointer-events-none">
          <div className="text-center p-6 bg-card/95 border border-accent-brand/40 flex flex-col items-center gap-3">
            <Download className="size-10 text-accent-brand" />
            <p className="text-[10px] font-bold uppercase tracking-widest text-accent-brand">
              {t("fileManager.dropToDownloadHere")}
            </p>
          </div>
        </div>
      )}

      <LocalFileContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        entries={contextMenu.entries}
        isVisible={contextMenu.visible}
        showHidden={showHidden}
        canUpload={!!onUploadToRemote}
        onClose={closeContextMenu}
        onOpen={openEntry}
        onUploadToRemote={(targets) =>
          onUploadToRemote?.(targets.map((e) => e.path))
        }
        onReveal={(entry) => {
          const target = entry?.path ?? pathRef.current;
          if (target && target !== THIS_PC) void revealLocalPath(target);
        }}
        onRename={startRename}
        onCopyPath={copyEntryPaths}
        onNewFolder={() => startCreate("folder")}
        onNewFile={() => startCreate("file")}
        onRefresh={() => refresh(true)}
        onToggleHidden={() => setShowHidden(!showHidden)}
        onDelete={trashEntries}
      />
    </div>
  );
}

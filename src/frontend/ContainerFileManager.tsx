/* eslint-disable react-hooks/exhaustive-deps */
import React from "react";
import { copyName } from "./copyName";
import {
  containingDirectory,
  isBrowsableArchive,
  isVirtualPath,
  isZipName,
  parentPath,
  virtualPath,
} from "./archivePath";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { useConfirm } from "./popup/useConfirm";
import { usePopups } from "./popup/usePopups";
import { popupTitle } from "./popup/popupTitle";
import { PopupHeader } from "./popup/PopupHeader";
import { POPUP_WIDTH, centerInPane } from "./popup/popupGeometry";
import { CompressWindow } from "./CompressWindow";
import { runWithProgress } from "./ArchiveProgressToast";
import { OpCancelled } from "./archiveProgressHelpers";
import { FileManagerGrid } from "./vendor/file-manager/FileManagerGrid";
import { FileManagerToolbar } from "./vendor/file-manager/FileManagerToolbar";
import {
  FileManagerContextMenu,
  type ExtraMenuItem,
} from "./vendor/file-manager/FileManagerContextMenu";
import { SymlinkWindow } from "./SymlinkWindow";
import { ExtractWindow } from "./ExtractWindow";
import { ArchiveWindow } from "./ArchiveWindow";
import { useArchiveExtract } from "./useArchiveExtract";
import { PermissionsWindow } from "./PermissionsWindow";
import { StatusStrip, type PanelButton } from "./StatusStrip";
import { FileWindow } from "./vendor/file-manager/components/FileWindow";
import {
  WindowManager,
  useWindowManager,
} from "./vendor/file-manager/components/WindowManager";
import { useFileSelection } from "./vendor/file-manager/hooks/useFileSelection";
import { runWithConcurrency } from "./vendor/file-manager/file-manager-utils";
import {
  capabilityBanner,
  execLimit,
  featureBlock,
  listingDetail,
  type Feature,
} from "./capabilityMessages";
import type { FileItem, SSHHost } from "./vendor/file-manager/host-types";
import type { CreateIntent } from "./vendor/file-manager/file-manager-types";
import {
  ContainerApiError,
  downloadBlob,
  isTooLargeDownload,
  downloadFallbackName,
  MAX_BUFFERED_DOWNLOAD,
  openDownload,
  responseFileName,
  fetchShells,
  type ApplyScope,
  type ContainerShells,
  fsApi,
  type ContainerLiveState,
  joinPath,
  listFiles,
  listArchiveFolder,
  saveBlob,
  sessionApi,
  targetKey,
  newTransferId,
  cancelTransfer,
  transferStatus,
  uploadFile,
} from "./containerFsApi";
import { ContainerFolderTree } from "./ContainerFolderTree";
import { useFolderTree } from "./useFolderTree";
import { parseInternalFiles } from "./workspace/dragRegistry";
import { UploadProgressToast } from "./UploadProgressToast";
import {
  canStreamToDisk,
  collectEntries,
  dirsToCreate,
  fromFileList,
  pickSaveHandle,
  pipeToHandle,
  topLevelOf,
  type SaveHandleLike,
  type UploadPlan,
} from "./webTransfer";
import type { PaneBridge } from "./workspace/types";
import {
  ShellPickerWindow,
  TerminalWindow,
  readRememberedShell,
  rememberShell,
} from "./ContainerTerminal";
import { pickShell } from "./terminalCommand";
import { Terminal } from "lucide-react";
import { previewVerdict } from "./mediaPreview";
import {
  EDIT_LIMIT_MIB,
  editGate,
  onEditRejected,
  type EditRejection,
} from "./editGate";
import { resolveFilePreviewKind } from "./vendor/file-manager/file-preview-preload";
import {
  containerName,
  type Capabilities,
  type ContainerInfo,
  type Runtime,
} from "./types";

type SortBy = "name" | "modified" | "size";

interface Props {
  sessionId: string;
  containerId: string;
  container: ContainerInfo | null;
  isVisible: boolean;
  runtime: Runtime | null;
  /** The SSH host record the terminal connects to. */
  hostConfig: unknown;
  /** A fresh state from polling; null when the container no longer exists. */
  onStateChange?: (state: ContainerLiveState | null) => void;
  /** Set by the multi-pane workspace; absent for a standalone manager. */
  bridge?: PaneBridge;
}

const STATE_POLL_MS = 5000;

interface Clipboard {
  files: FileItem[];
  cut: boolean;
}

const TRANSFER_CONCURRENCY = 2;

const ARCHIVE_EXT =
  /.(zip|tar|tgz|gz|bz2|xz|zst|7z|rar|jar|war|deb|rpm|iso|exe|dll|so|bin|class)$/i;

const parentOf = parentPath;

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function normalizePath(path: string, from: string): string {
  const raw = path.startsWith("/") ? path : `${from}/${path}`;
  const out: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

function Inner({
  sessionId,
  containerId,
  container,
  isVisible,
  runtime,
  hostConfig,
  onStateChange,
  bridge,
}: Props) {
  const { t } = useTranslation();
  const initial = React.useRef(bridge?.initial).current;
  const startPath = React.useRef("/");
  const label = container ? containerName(container) : containerId.slice(0, 12);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const confirm = useConfirm(label, rootRef);
  const extractEntries = useArchiveExtract(label);
  const { openWindow: openManaged, closeWindow } = useWindowManager();
  // Every window this pane opens, so none outlives the pane or its container.
  const ownedWindows = React.useRef(new Set<string>());
  const openWindow: typeof openManaged = (win) => {
    const id = openManaged(win);
    ownedWindows.current.add(id);
    return id;
  };
  const openPopup = usePopups({
    paneRef: rootRef,
    label,
    onOpen: (id) => ownedWindows.current.add(id),
  });
  const key = React.useMemo(
    () => targetKey(sessionId, containerId),
    [sessionId, containerId],
  );
  // The pane closed or switched container: its windows go with it.
  React.useEffect(() => {
    const owned = ownedWindows.current;
    return () => {
      for (const id of owned) closeWindow(id);
      owned.clear();
    };
  }, [key]);

  const [caps, setCaps] = React.useState<Capabilities | null>(null);
  // Polled state; null until the first answer (the list's value is used then).
  const [liveRunning, setLiveRunning] = React.useState<boolean | null>(null);
  const [gone, setGone] = React.useState(false);
  const [currentPath, setCurrentPath] = React.useState(startPath.current);
  const [history, setHistory] = React.useState<string[]>([startPath.current]);
  const [historyIndex, setHistoryIndex] = React.useState(0);
  const [files, setFiles] = React.useState<FileItem[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [truncated, setTruncated] = React.useState(false);
  const inArchive = isVirtualPath(currentPath);
  const tree = useFolderTree(key, currentPath, !inArchive);
  // A finished listing (navigation or a change) refreshes the opened node.
  React.useEffect(() => {
    if (!isLoading && !inArchive && !loadError) void tree.load(currentPath);
  }, [isLoading]);
  const { selectedFiles, setSelection, clearSelection } = useFileSelection();
  const [searchQuery, setSearchQuery] = React.useState("");
  const [viewMode, setViewMode] = React.useState<"grid" | "list">(
    initial?.viewMode ?? "list",
  );
  const [density, setDensity] = React.useState<"comfortable" | "compact">(
    initial?.density ?? "comfortable",
  );
  const [sortBy, setSortBy] = React.useState<SortBy>(initial?.sortBy ?? "name");
  const [sortOrder, setSortOrder] = React.useState<"asc" | "desc">(
    initial?.sortOrder ?? "asc",
  );
  const [clipboard, setClipboard] = React.useState<Clipboard | null>(null);
  const [editingFile, setEditingFile] = React.useState<FileItem | null>(null);
  const [createIntent, setCreateIntent] = React.useState<CreateIntent | null>(
    null,
  );
  const [menu, setMenu] = React.useState<{
    x: number;
    y: number;
    files: FileItem[];
  } | null>(null);

  const listAbort = React.useRef<AbortController | null>(null);
  const historyRef = React.useRef<string[]>([startPath.current]);
  const indexRef = React.useRef(0);
  const listedPath = React.useRef<string | null>(null);
  const pathRef = React.useRef(currentPath);
  pathRef.current = currentPath;
  const filesRef = React.useRef(files);
  filesRef.current = files;

  const running =
    liveRunning ?? (container ? container.state === "running" : true);

  // A shim host: the vendored editor window only reads display fields from it.
  const pseudoHost = React.useMemo(
    () =>
      ({
        id: 0,
        name: container?.name ?? containerId,
        ip: "",
        port: 0,
        username: "",
      }) as unknown as SSHHost,
    [container?.name, containerId],
  );

  // ---- listing ----------------------------------------------------------

  const load = React.useCallback(
    async (path: string, options: { keepSelection?: boolean } = {}) => {
      listAbort.current?.abort();
      const controller = new AbortController();
      listAbort.current = controller;
      // A different folder must never show (or act on) the previous one.
      if (listedPath.current !== path) setFiles([]);
      listedPath.current = path;
      setIsLoading(true);
      setLoadError(null);
      let first = true;
      try {
        const result = isVirtualPath(path)
          ? await listArchiveFolder(key, path, controller.signal)
          : await listFiles(key, path, {
              signal: controller.signal,
              onChunk: (chunk) => {
                if (controller.signal.aborted) return;
                // React runs the updater later, so `first` must be read now.
                const replace = first;
                first = false;
                setFiles((prev) => (replace ? chunk : [...prev, ...chunk]));
              },
            });
        if (controller.signal.aborted) return;
        if (isVirtualPath(path)) {
          first = false;
          setFiles(result.files);
        }
        if (controller.signal.aborted) return;
        if (first) setFiles([]);
        setTruncated(result.meta.truncated);
        if (result.path !== path) setCurrentPath(result.path);
        if (!options.keepSelection) clearSelection();
      } catch (error) {
        if (controller.signal.aborted) return;
        if (path !== "/" && path === startPath.current) {
          // The remembered folder is gone: fall back to the root.
          startPath.current = "/";
          historyRef.current = ["/"];
          setHistory(["/"]);
          setCurrentPath("/");
          void load("/");
          return;
        }
        setLoadError(errorText(error, t("containerFiles.listFailed")));
        setFiles([]);
      } finally {
        if (listAbort.current === controller) setIsLoading(false);
      }
    },
    [key],
  );

  React.useEffect(() => {
    let cancelled = false;
    sessionApi
      .capabilities(key)
      .then((value) => {
        if (!cancelled) setCaps(value);
      })
      .catch(() => {});
    void load(startPath.current);
    return () => {
      cancelled = true;
      listAbort.current?.abort();
    };
  }, [key]);

  // The container can be started, stopped or removed while this is open:
  // poll its state, update what is allowed, and reload when it comes back up.
  const wasRunning = React.useRef<boolean | null>(
    container ? container.state === "running" : null,
  );
  const onStateChangeRef = React.useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await check();
      } finally {
        running = false;
      }
      if (!cancelled) timer = setTimeout(() => void tick(), STATE_POLL_MS);
    };
    const check = async () => {
      if (!cancelled && !document.hidden) {
        try {
          const state = await sessionApi.state(key);
          if (cancelled) return;
          setGone(false);
          setCaps(state.capabilities);
          setLiveRunning(state.running);
          const before = wasRunning.current;
          wasRunning.current = state.running;
          if (before === false && state.running) void refreshRef.current();
          onStateChangeRef.current?.(state);
        } catch (error) {
          if (cancelled) return;
          if (error instanceof ContainerApiError && error.status === 404) {
            setGone(true);
            onStateChangeRef.current?.(null);
          }
          // other errors: the next poll tries again
        }
      }
    };
    const onVisible = () => {
      if (!document.hidden && !cancelled) {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    timer = setTimeout(() => void tick(), STATE_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key]);

  // A refresh keeps the selection but must hand out the fresh items, or the
  // properties dialog would show attributes from before the change.
  React.useEffect(() => {
    if (isLoading || selectedFiles.length === 0) return;
    const byPath = new Map(files.map((f) => [f.path, f]));
    const next = selectedFiles
      .map((f) => byPath.get(f.path))
      .filter((f): f is FileItem => !!f);
    const changed =
      next.length !== selectedFiles.length ||
      next.some((f, i) => f !== selectedFiles[i]);
    if (changed) setSelection(next);
  }, [isLoading, files]);

  const refresh = React.useCallback(
    () => load(pathRef.current, { keepSelection: true }),
    [load],
  );
  const refreshRef = React.useRef(refresh);
  refreshRef.current = refresh;

  // Workspace hooks: expose this pane and remember its view.
  const selectedRef = React.useRef(selectedFiles);
  selectedRef.current = selectedFiles;
  React.useEffect(() => {
    if (!bridge) return;
    bridge.register({
      getDir: () => pathRef.current,
      refresh: () => void refreshRef.current(),
      isDirectory: (p) =>
        filesRef.current.some((f) => f.path === p && f.type === "directory"),
      getSelection: () => selectedRef.current,
    });
    return () => bridge.register(null);
  }, [bridge?.paneId]);
  React.useEffect(() => {
    bridge?.saveState({
      viewMode,
      density,
      sortBy,
      sortOrder,
    });
  }, [viewMode, density, sortBy, sortOrder]);

  const navigateTo = React.useCallback(
    (path: string, record = true) => {
      const target = normalizePath(path, pathRef.current);
      setCurrentPath(target);
      setSearchQuery("");
      if (record) {
        const next = [
          ...historyRef.current.slice(0, indexRef.current + 1),
          target,
        ];
        historyRef.current = next;
        indexRef.current = next.length - 1;
        setHistory(next);
        setHistoryIndex(indexRef.current);
      }
      void load(target);
    },
    [load],
  );

  const goBack = () => {
    if (indexRef.current <= 0) return;
    indexRef.current -= 1;
    setHistoryIndex(indexRef.current);
    navigateTo(historyRef.current[indexRef.current], false);
  };
  const goForward = () => {
    if (indexRef.current >= historyRef.current.length - 1) return;
    indexRef.current += 1;
    setHistoryIndex(indexRef.current);
    navigateTo(historyRef.current[indexRef.current], false);
  };
  const goUp = () => navigateTo(parentOf(pathRef.current));

  // ---- helpers ----------------------------------------------------------

  // Explains concretely why a change cannot be made (stopped, no shell, no
  // exec permission, missing tool, ...); null when it can.
  const guardWrite = (feature: Feature, tool?: string): boolean => {
    if (isVirtualPath(pathRef.current)) {
      toast.error(t("containerFiles.archiveReadOnly"));
      return false;
    }
    const reason = featureBlock(caps, feature, t, tool);
    if (!reason) return true;
    toast.error(reason);
    return false;
  };

  // ---- terminal ---------------------------------------------------------

  // Opens the terminal at once with the container's default shell. The shell
  // dialog appears only when no shell can be chosen or the terminal ends right
  // after starting.
  const requestTerminal = async (path: string) => {
    if (isVirtualPath(pathRef.current) || isVirtualPath(path)) {
      toast.error(t("containerFiles.terminalInArchive"));
      return;
    }
    if (gone || !running) {
      toast.error(
        gone
          ? t("containerFiles.containerGone")
          : (featureBlock(caps, "terminal", t) ??
              t("containerFiles.terminalNeedsRunning")),
      );
      return;
    }
    const terminalBlock = featureBlock(caps, "terminal", t);
    if (terminalBlock) {
      toast.error(terminalBlock);
      return;
    }
    let info: ContainerShells = { shells: [], default: null };
    let lookupFailed = false;
    try {
      info = await fetchShells(key);
    } catch {
      lookupFailed = true;
    }
    const shell = readRememberedShell(containerId) ?? pickShell(info);
    if (shell) {
      launchTerminal(path, shell, info.shells);
      return;
    }
    openShellPicker(
      path,
      info.shells,
      undefined,
      lookupFailed
        ? t("containerFiles.terminalShellLookupFailed")
        : t("containerFiles.terminalNoShell"),
    );
  };

  const containerLabel = () => label;

  const launchTerminal = (dir: string, shell: string, shells: string[]) => {
    const size = { width: 800, height: 500 };
    const place = centerInPane(rootRef.current, size);
    openWindow({
      title: t("containerFiles.terminalWindowTitle"),
      x: place.x,
      y: place.y,
      width: place.width,
      height: place.height,
      isMaximized: false,
      isMinimized: false,
      component: (windowId: string) => (
        <TerminalWindow
          windowId={windowId}
          title={t("containerFiles.terminalWindowTitle")}
          container={containerLabel()}
          sessionId={sessionId}
          containerId={containerId}
          dir={dir}
          shell={shell}
          hostConfig={hostConfig}
          onStarted={() => rememberShell(containerId, shell)}
          onFailed={(message) => {
            rememberShell(containerId, null);
            openShellPicker(dir, shells, shell, message);
          }}
        />
      ),
    });
  };

  // A floating window like the editor; shown only when starting a shell failed.
  const openShellPicker = (
    dir: string,
    shells: string[],
    initial: string | undefined,
    notice: string | undefined,
  ) => {
    openPopup({
      title: t("containerFiles.shellPickerTitle"),
      width: POPUP_WIDTH.normal,
      height: 520,
      minWidth: 420,
      minHeight: 360,
      fit: false,
      render: () => (
        <ShellPickerWindow
          containerKey={key}
          shells={shells}
          initial={initial}
          notice={notice}
          onOpen={(shell) => launchTerminal(dir, shell, shells)}
        />
      ),
    });
  };

  const openPermissionsWindow = (file: FileItem) => {
    if (isVirtualPath(file.path)) {
      toast.error(t("containerFiles.archiveReadOnly"));
      return;
    }
    openPopup({
      title: t("fileManager.changePermissions"),
      extra: file.name,
      width: POPUP_WIDTH.normal,
      minHeight: 300,
      render: () => (
        <PermissionsWindow
          file={file}
          containerKey={key}
          onSave={handleSavePermissions}
          onChangeOwner={handleChangeOwner}
        />
      ),
    });
  };

  // Create a link (in the open folder, to `file` when one is selected) or
  // change what an existing link points at.
  const openSymlinkWindow = (mode: "create" | "edit", file?: FileItem) => {
    if (!guardWrite("symlink")) return;
    const editing = mode === "edit" && !!file;
    const dir = editing ? parentOf(file.path) : pathRef.current;
    const title = t(
      editing
        ? "containerFiles.linkEditTitle"
        : "containerFiles.linkCreateTitle",
    );
    openPopup({
      title,
      width: POPUP_WIDTH.normal,
      render: () => (
        <SymlinkWindow
          mode={editing ? "edit" : "create"}
          dir={dir}
          containerKey={key}
          initialName={editing ? file.path : file ? `${file.name}-link` : ""}
          initialTarget={editing ? (file.linkTarget ?? "") : (file?.path ?? "")}
          onSubmit={async (path, target, force) => {
            await fsApi.symlink(key, target, path, force);
            toast.success(t("containerFiles.linkDone"));
            await load(pathRef.current);
          }}
        />
      ),
    });
  };

  // Opens an archive in a floating window; entries drag out or extract from there.
  const openArchive = (file: FileItem) => {
    const tool = isZipName(file.name) ? "unzip" : "tar";
    if (caps && !caps.tools.includes(tool)) {
      toast.error(t("containerFiles.archiveNoTool", { tool }));
      return;
    }
    openPopup({
      title: t("containerFiles.archiveWindowTitle"),
      extra: file.name,
      width: 720,
      height: 480,
      minWidth: 420,
      minHeight: 260,
      fit: false,
      bare: true,
      render: () => (
        <ArchiveWindow
          containerKey={key}
          containerId={containerId}
          archive={file.path}
          archiveName={file.name}
          onExtractSelected={(entries) => askExtractEntries(file, entries)}
          onExtractAll={() => handleExtract(file)}
        />
      ),
    });
  };

  // Asks where to put chosen archive entries (default: the open folder).
  const askExtractEntries = (file: FileItem, entries: string[]) => {
    if (!guardWrite("extract", isZipName(file.name) ? "unzip" : "tar")) return;
    openPopup({
      title: t("containerFiles.extractTitle"),
      extra: file.name,
      width: POPUP_WIDTH.normal,
      render: () => (
        <ExtractWindow
          containerKey={key}
          archiveName={file.name}
          initialDest={isVirtualPath(pathRef.current) ? "/" : pathRef.current}
          onExtract={(dest) =>
            void extractEntries(key, file.path, entries, dest).then((ok) => {
              if (ok) void refresh();
            })
          }
        />
      ),
    });
  };

  const linkMenuItems = (selected: FileItem[]): ExtraMenuItem[] => {
    if (isVirtualPath(pathRef.current)) return [];
    const items: ExtraMenuItem[] = [
      {
        label: t("web.uploadFolder"),
        action: () => pickInput(true),
      },
    ];
    if (selected.length === 1 && isBrowsableArchive(selected[0].name)) {
      items.push({
        label: t("containerFiles.archiveOpenMenu"),
        action: () => openArchive(selected[0]),
      });
    }
    items.push({
      label: t("containerFiles.linkCreateMenu"),
      action: () => openSymlinkWindow("create", selected[0]),
    });
    if (selected.length === 1 && selected[0].linkTarget) {
      items.push({
        label: t("containerFiles.linkEditMenu"),
        action: () => openSymlinkWindow("edit", selected[0]),
      });
    }
    return items;
  };

  const run = async (action: () => Promise<unknown>, failed: string) => {
    try {
      await action();
      return true;
    } catch (error) {
      if (error instanceof OpCancelled)
        toast.info(t("containerFiles.opCancelled"));
      else toast.error(errorText(error, failed));
      return false;
    }
  };

  const exists = (name: string) =>
    filesRef.current.some((f) => f.name === name);

  const confirmOverwrite = (name: string) =>
    confirm({
      title: t("containerFiles.overwriteTitle"),
      description: t("containerFiles.overwriteDesc", { name }),
      confirmLabel: t("containerFiles.overwrite"),
      destructive: true,
    });

  // ---- open -------------------------------------------------------------

  // Editor windows by id, so a refused file can have its window closed.
  const editorWindows = React.useRef(new Map<string, string>());

  const offerDownload = async (
    file: FileItem,
    reason: EditRejection,
    size?: number,
  ) => {
    const gate = editGate(size);
    const ok = await confirm({
      title: t(
        reason === "binary"
          ? "containerFiles.binaryTitle"
          : "containerFiles.editTooLargeTitle",
      ),
      description:
        reason === "binary"
          ? t("containerFiles.binaryDescription", { name: file.name })
          : t("containerFiles.editTooLargeDescription", {
              size: "sizeMiB" in gate ? gate.sizeMiB : "?",
              limit: EDIT_LIMIT_MIB,
            }),
      confirmLabel: t("containerFiles.download"),
      destructive: false,
    });
    if (ok) await handleDownload([file]);
  };

  // The backend refused to hand the file to the editor (too large, binary):
  // close the empty window and say so once.
  React.useEffect(
    () =>
      onEditRejected((sessionId, path, reason) => {
        if (sessionId !== key) return false;
        const entry = [...editorWindows.current]
          .reverse()
          .find(([, p]) => p === path);
        if (!entry) return false;
        editorWindows.current.delete(entry[0]);
        closeWindow(entry[0]);
        const file =
          filesRef.current.find((f) => f.path === path) ??
          ({
            name: path.split("/").pop() ?? path,
            path,
            type: "file",
          } as FileItem);
        void (async () => {
          let size = file.size;
          if (!size) {
            try {
              size = (await fsApi.stat(key, path)).size;
            } catch {
              /* unknown */
            }
          }
          await offerDownload(file, reason, size);
        })();
        return true;
      }),
    [key],
  );

  const openEditor = (file: FileItem) => {
    const { x, y } = centerInPane(rootRef.current, { width: 800, height: 600 });
    const windowId = openWindow({
      title: file.name,
      x,
      y,
      width: 800,
      height: 600,
      isMaximized: false,
      isMinimized: false,
      component: (windowId: string) => (
        <FileWindow
          windowId={windowId}
          file={file}
          title={popupTitle({
            what: t("fileManager.editor"),
            container: label,
            extra: file.name,
          })}
          label=""
          titleContent={
            <PopupHeader
              what={t("fileManager.editor")}
              container={label}
              extra={file.path}
            />
          }
          sshSessionId={key}
          sshHost={pseudoHost}
          initialX={x}
          initialY={y}
          onFileNotFound={() => void refresh()}
        />
      ),
    });
    editorWindows.current.set(windowId, file.path);
  };

  const handleOpen = async (file: FileItem) => {
    if (file.type === "directory") {
      navigateTo(file.path);
      return;
    }
    if (file.type === "link" && isVirtualPath(file.path)) {
      toast.info(
        t("containerFiles.archiveLinkOpen", { target: file.linkTarget ?? "" }),
      );
      return;
    }
    if (file.type === "link") {
      // Links the listing could not classify are resolved on the spot.
      try {
        const info = await fsApi.stat(key, file.path);
        if (info.type === "directory") navigateTo(file.path);
        else openEditor(file);
      } catch (error) {
        toast.error(errorText(error, t("containerFiles.openFailed")));
      }
      return;
    }
    if (isBrowsableArchive(file.name) && !isVirtualPath(file.path)) {
      openArchive(file);
      return;
    }
    if (ARCHIVE_EXT.test(file.name) && !isVirtualPath(file.path)) {
      if (
        await confirm({
          title: t("containerFiles.binaryTitle"),
          description: t("containerFiles.binaryDescription", {
            name: file.name,
          }),
          confirmLabel: t("containerFiles.download"),
          destructive: false,
        })
      ) {
        await handleDownload([file]);
      }
      return;
    }
    const verdict = previewVerdict(file.name, file.size);
    if (verdict && verdict.preview === false) {
      const mb = Math.round(verdict.limit / (1024 * 1024));
      if (
        await confirm({
          title: t(
            verdict.reason === "unsupported"
              ? "containerFiles.mediaUnsupportedTitle"
              : "containerFiles.mediaTooLargeTitle",
          ),
          description: t(
            verdict.reason === "unsupported"
              ? "containerFiles.mediaUnsupportedDescription"
              : "containerFiles.mediaTooLargeDescription",
            { name: file.name, limit: mb },
          ),
          confirmLabel: t("containerFiles.download"),
          destructive: false,
        })
      ) {
        await handleDownload([file]);
      }
      return;
    }
    // Text opens only up to the editor limit: no empty window first.
    if (!verdict) {
      let size = file.size;
      if (!size) {
        try {
          size = (await fsApi.stat(key, file.path)).size;
        } catch {
          /* the editor reports a real failure */
        }
      }
      if (!editGate(size).ok) {
        await offerDownload(file, "tooLarge", size);
        return;
      }
    }
    openEditor(file);
  };

  // ---- create / rename / delete ----------------------------------------

  const startCreate = (type: "file" | "directory") => {
    if (!guardWrite("create")) return;
    const defaultName =
      type === "file" ? t("fileManager.newFile") : t("fileManager.newFolder");
    setCreateIntent({
      id: `create-${Date.now()}`,
      type,
      defaultName,
      currentName: defaultName,
    });
  };

  const confirmCreate = async (name: string) => {
    const intent = createIntent;
    setCreateIntent(null);
    const clean = name.trim();
    if (!intent || !clean) return;
    if (clean.includes("/")) {
      toast.error(t("containerFiles.invalidName"));
      return;
    }
    const path = joinPath(pathRef.current, clean);
    const ok = await run(
      () =>
        intent.type === "directory"
          ? fsApi.mkdir(key, path)
          : fsApi.create(key, path),
      t("containerFiles.createFailed"),
    );
    if (ok) await refresh();
  };

  const handleRename = async (file: FileItem, newName: string) => {
    setEditingFile(null);
    const clean = newName.trim();
    if (!clean || clean === file.name) return;
    if (!guardWrite("rename")) return;
    if (clean.includes("/")) {
      toast.error(t("containerFiles.invalidName"));
      return;
    }
    const ok = await run(
      () => fsApi.rename(key, file.path, joinPath(parentOf(file.path), clean)),
      t("containerFiles.renameFailed"),
    );
    if (ok) await refresh();
  };

  const handleDelete = async (items: FileItem[]) => {
    if (items.length === 0 || !guardWrite("delete")) return;
    const confirmed = await confirm({
      title: t("containerFiles.deleteTitle"),
      description:
        items.length === 1
          ? t("containerFiles.deleteOne", { name: items[0].name })
          : t("containerFiles.deleteMany", { count: items.length }),
      confirmLabel: t("containerFiles.delete"),
      destructive: true,
    });
    if (!confirmed) return;
    const ok = await run(
      () =>
        fsApi.delete(
          key,
          items.map((f) => f.path),
        ),
      t("containerFiles.deleteFailed"),
    );
    clearSelection();
    if (ok) await refresh();
  };

  // ---- clipboard --------------------------------------------------------

  const handleCopy = (items: FileItem[]) => {
    if (items.length === 0) return;
    if (isVirtualPath(pathRef.current)) {
      toast.error(t("containerFiles.archiveReadOnly"));
      return;
    }
    setClipboard({ files: items, cut: false });
    bridge?.setClipboard(items, false);
    toast.success(t("containerFiles.copied", { count: items.length }));
  };
  const handleCut = (items: FileItem[]) => {
    if (items.length === 0 || !guardWrite("paste")) return;
    setClipboard({ files: items, cut: true });
    bridge?.setClipboard(items, true);
    toast.success(t("containerFiles.cut", { count: items.length }));
  };

  const transferInto = async (
    items: FileItem[],
    destDir: string,
    cut: boolean,
  ) => {
    if (!guardWrite("paste")) return;
    let failed = 0;
    for (const item of items) {
      let name = item.name;
      let dest = joinPath(destDir, name);
      if (dest === item.path) {
        if (cut) continue;
        name = copyName(item.name, exists, item.type === "directory");
        dest = joinPath(destDir, name);
      }
      if (cut && (dest === item.path || dest.startsWith(`${item.path}/`)))
        continue;
      let overwrite = false;
      if (destDir === pathRef.current && exists(name)) {
        if (!(await confirmOverwrite(name))) continue;
        overwrite = true;
      }
      try {
        if (cut) await fsApi.move(key, item.path, dest, overwrite);
        else await fsApi.copy(key, item.path, dest, overwrite);
      } catch (error) {
        if (
          error instanceof ContainerApiError &&
          error.code === "EXISTS" &&
          !overwrite &&
          (await confirmOverwrite(name))
        ) {
          try {
            if (cut) await fsApi.move(key, item.path, dest, true);
            else await fsApi.copy(key, item.path, dest, true);
            continue;
          } catch (retry) {
            toast.error(errorText(retry, t("containerFiles.pasteFailed")));
            failed++;
            continue;
          }
        }
        toast.error(errorText(error, t("containerFiles.pasteFailed")));
        failed++;
      }
    }
    if (failed < items.length) await refresh();
  };

  const handlePaste = async () => {
    if (isVirtualPath(pathRef.current)) {
      toast.error(t("containerFiles.archiveReadOnly"));
      return;
    }
    if (bridge && (await bridge.paste(pathRef.current))) return;
    if (!clipboard) return;
    await transferInto(clipboard.files, pathRef.current, clipboard.cut);
    if (clipboard.cut) setClipboard(null);
  };

  const handleFileDrop = async (dragged: FileItem[], target: FileItem) => {
    if (target.type !== "directory") return;
    if (isVirtualPath(pathRef.current)) {
      toast.error(t("containerFiles.archiveReadOnly"));
      return;
    }
    const items = dragged.filter(
      (f) => f.path !== target.path && !target.path.startsWith(`${f.path}/`),
    );
    if (items.length > 0) await transferInto(items, target.path, true);
  };

  // ---- properties / archives -------------------------------------------

  const handleSavePermissions = async (
    file: FileItem,
    permissions: string,
    recursive: boolean,
    scope: ApplyScope,
  ) => {
    if (!guardWrite("permissions")) return;
    const ok = await run(
      () => fsApi.chmod(key, file.path, permissions, recursive, scope),
      t("containerFiles.chmodFailed"),
    );
    if (ok) {
      toast.success(t("containerFiles.chmodDone"));
      await refresh();
    }
  };

  const handleChangeOwner = async (
    file: FileItem,
    owner: string,
    recursive: boolean,
    scope: ApplyScope,
  ) => {
    if (!guardWrite("owner")) throw new Error("read-only");
    const ok = await run(
      () => fsApi.chown(key, file.path, owner, recursive, scope),
      t("containerFiles.chownFailed"),
    );
    if (!ok) throw new Error("chown failed");
  };

  const openCompress = (items: FileItem[]) => {
    if (!guardWrite("compress")) return;
    openPopup({
      title: t("fileManager.compressFiles"),
      extra: items.length === 1 ? items[0].name : String(items.length),
      width: POPUP_WIDTH.normal,
      render: () => (
        <CompressWindow
          fileNames={items.map((f) => f.name)}
          onCompress={(n, f) => void handleCompress(items, n, f)}
        />
      ),
    });
  };

  const handleCompress = async (
    items: FileItem[],
    archiveName: string,
    format: string,
  ) => {
    const map: Record<string, "tar" | "tgz" | "zip"> = {
      zip: "zip",
      tar: "tar",
      "tar.gz": "tgz",
    };
    const fmt = map[format];
    if (!fmt) {
      toast.error(t("containerFiles.formatUnsupported", { format }));
      return;
    }
    if (!guardWrite("compress")) return;
    const ok = await run(
      () =>
        runWithProgress({
          t,
          kind: "compress",
          name: archiveName,
          task: (track) =>
            fsApi.compress(
              key,
              pathRef.current,
              items.map((f) => f.name),
              joinPath(pathRef.current, archiveName),
              fmt,
              track,
            ),
        }),
      t("containerFiles.compressFailed"),
    );
    if (ok) {
      toast.success(t("containerFiles.compressDone", { name: archiveName }));
      await refresh();
    }
  };

  // Asks where to extract (default: the open folder), then extracts there.
  const handleExtract = (file: FileItem) => {
    if (!guardWrite("extract", /.zip$/i.test(file.name) ? "unzip" : "tar"))
      return;
    openPopup({
      title: t("containerFiles.extractTitle"),
      extra: file.name,
      width: POPUP_WIDTH.normal,
      render: () => (
        <ExtractWindow
          containerKey={key}
          archiveName={file.name}
          initialDest={pathRef.current}
          onExtract={(dest) => void extractTo(file, dest)}
        />
      ),
    });
  };

  const extractTo = async (file: FileItem, dest: string) => {
    let overwrite = false;
    const extractWith = (over: boolean) =>
      runWithProgress({
        t,
        kind: "extract",
        name: file.name,
        task: (track) => fsApi.extract(key, file.path, dest, over, track),
      });
    try {
      await extractWith(false);
    } catch (error) {
      if (error instanceof OpCancelled) {
        toast.info(t("containerFiles.opCancelled"));
        return;
      }
      if (!(error instanceof ContainerApiError && error.code === "EXISTS")) {
        toast.error(errorText(error, t("containerFiles.extractFailed")));
        return;
      }
      const confirmed = await confirm({
        title: t("containerFiles.extractOverwriteTitle"),
        description: t("containerFiles.extractOverwriteDesc", {
          name: file.name,
        }),
        confirmLabel: t("containerFiles.overwrite"),
        destructive: true,
      });
      if (!confirmed) return;
      overwrite = true;
    }
    if (overwrite) {
      const ok = await run(
        () => extractWith(true),
        t("containerFiles.extractFailed"),
      );
      if (!ok) return;
    }
    toast.success(t("containerFiles.extractDone", { name: file.name }));
    await refresh();
  };

  // ---- download / upload ------------------------------------------------

  const handleDownload = async (items: FileItem[]) => {
    for (const item of items) {
      if (item.type === "directory" && isVirtualPath(item.path)) {
        toast.error(t("containerFiles.archiveFolderDownload"));
        continue;
      }
      const controller = new AbortController();
      const cancel = {
        label: t("fileManager.cancel"),
        onClick: () => controller.abort(),
      };
      const id = toast.loading(
        t("containerFiles.downloading", { name: item.name }),
        { cancel },
      );
      let finished = false;
      const kind = item.type === "directory" ? "directory" : "file";
      const transferId = newTransferId("dl");
      const progress = (loaded: number, total?: number) => {
        if (finished) return;
        toast.loading(
          t("containerFiles.downloadingProgress", {
            name: item.name,
            loaded: Math.round(loaded / 1024),
            total: total ? Math.round(total / 1024) : "?",
          }),
          { id, cancel },
        );
      };
      try {
        // Stream to disk when the browser can; the picker needs the click's
        // user gesture, so it only works for the first item of a batch.
        let handle: SaveHandleLike | null = null;
        if (canStreamToDisk()) {
          try {
            handle = await pickSaveHandle(
              downloadFallbackName(item.path, kind),
            );
          } catch (error) {
            if ((error as Error)?.name === "AbortError") {
              toast.dismiss(id);
              continue;
            }
          }
        }
        if (handle) {
          const response = await openDownload(key, item.path, kind, {
            signal: controller.signal,
            transferId,
          });
          const total =
            Number(response.headers.get("content-length")) || undefined;
          if (!response.body) throw new Error("Empty response");
          await pipeToHandle(response.body, handle, {
            signal: controller.signal,
            onProgress: (loaded) => progress(loaded, total),
          });
        } else {
          const { blob, fileName } = await downloadBlob(key, item.path, kind, {
            signal: controller.signal,
            transferId,
            maxBytes: MAX_BUFFERED_DOWNLOAD,
            onProgress: progress,
          });
          saveBlob(blob, fileName);
        }
        finished = true;
        toast.dismiss(id);
        toast.success(t("containerFiles.downloaded", { name: item.name }));
      } catch (error) {
        finished = true;
        toast.dismiss(id);
        if (controller.signal.aborted) {
          void cancelTransfer(transferId);
          toast.info(t("fileManager.localTransferCancelled"));
          return;
        }
        toast.error(
          isTooLargeDownload(error)
            ? t("containerFiles.downloadTooLarge")
            : errorText(error, t("containerFiles.downloadFailed")),
        );
      } finally {
        // A progress toast must never outlive its transfer.
        finished = true;
        toast.dismiss(id);
      }
    }
  };

  const uploadAll = async (
    entries: { file: File; rel?: string }[],
    destDir: string,
    emptyDirs: string[] = [],
  ) => {
    if (
      (entries.length === 0 && emptyDirs.length === 0) ||
      !guardWrite("upload")
    )
      return;
    const controller = new AbortController();
    const active = new Map<
      string,
      { name: string; size: number; bytes: number }
    >();
    let finishedBytes = 0;
    let totalBytes = entries.reduce((sum, e) => sum + e.file.size, 0);
    let done = 0;
    let failed = 0;
    let closed = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    const render = () => {
      if (closed || controller.signal.aborted) return;
      let loaded = finishedBytes;
      for (const a of active.values()) loaded += Math.min(a.bytes, a.size);
      toast.loading(
        <UploadProgressToast
          t={t}
          names={Array.from(active.values(), (a) => a.name)}
          done={done}
          count={entries.length}
          loaded={loaded}
          total={totalBytes}
        />,
        {
          id,
          duration: Infinity,
          cancel: {
            label: t("fileManager.cancel"),
            onClick: () => {
              controller.abort();
              for (const tid of active.keys()) void cancelTransfer(tid);
            },
          },
        },
      );
    };
    const id = toast.loading(
      t("containerFiles.uploading", { count: entries.length }),
    );
    try {
      const skip = new Set<string>();
      const overwrite = new Set<string>();
      for (const { file, rel } of entries) {
        const top = topLevelOf(rel ?? file.name);
        if (destDir === pathRef.current && exists(top) && !overwrite.has(top)) {
          if (skip.has(top)) continue;
          if (await confirmOverwrite(top)) overwrite.add(top);
          else skip.add(top);
        }
      }
      for (const entry of entries) {
        if (skip.has(topLevelOf(entry.rel ?? entry.file.name)))
          totalBytes -= entry.file.size;
      }
      for (const dir of emptyDirs) {
        const top = topLevelOf(dir);
        if (
          destDir === pathRef.current &&
          exists(top) &&
          !overwrite.has(top) &&
          !skip.has(top)
        ) {
          if (await confirmOverwrite(top)) overwrite.add(top);
          else skip.add(top);
        }
      }
      for (const dir of emptyDirs) {
        if (skip.has(topLevelOf(dir)) || controller.signal.aborted) continue;
        const target = joinPath(destDir, dir);
        try {
          await fsApi.mkdir(key, target);
        } catch (error) {
          // A confirmed overwrite of an existing folder is not a failure.
          if (
            error instanceof ContainerApiError &&
            error.code === "EXISTS" &&
            (await fsApi
              .stat(key, target)
              .then((st) => st.type === "directory")
              .catch(() => false))
          )
            continue;
          failed++;
          toast.error(`${dir}: ${errorText(error, "")}`);
        }
      }
      render();
      poll = setInterval(() => {
        for (const [tid, a] of active) {
          void transferStatus(tid).then((s) => {
            if (s && active.has(tid)) a.bytes = s.bytes;
          });
        }
        render();
      }, 500);
      await runWithConcurrency(entries, TRANSFER_CONCURRENCY, async (entry) => {
        const top = topLevelOf(entry.rel ?? entry.file.name);
        if (skip.has(top) || controller.signal.aborted) return;
        const transferId = newTransferId("up");
        active.set(transferId, {
          name: entry.file.name,
          size: entry.file.size,
          bytes: 0,
        });
        render();
        try {
          await uploadFile(
            key,
            destDir,
            entry.file,
            entry.rel ? { rel: entry.rel } : { name: entry.file.name },
            {
              overwrite: overwrite.has(top) || undefined,
              mtime: Math.floor(entry.file.lastModified / 1000),
              transferId,
              signal: controller.signal,
            },
          );
        } catch (error) {
          if (!controller.signal.aborted) {
            failed++;
            toast.error(`${entry.file.name}: ${errorText(error, "")}`);
          }
        }
        active.delete(transferId);
        finishedBytes += entry.file.size;
        done++;
        render();
      });
      if (controller.signal.aborted) {
        toast.info(t("fileManager.localTransferCancelled"));
      } else if (failed === 0) {
        toast.success(t("containerFiles.uploaded", { count: done }));
      }
    } finally {
      // The progress toast has a Cancel button and no timeout: always remove it.
      closed = true;
      clearInterval(poll);
      toast.dismiss(id);
    }
    await refresh();
  };

  const uploadPlan = (plan: UploadPlan) =>
    uploadAll(plan.files, pathRef.current, dirsToCreate(plan));

  const handleFilesDropped = (list: FileList) =>
    void uploadAll(
      Array.from(list).map((file) => ({ file })),
      pathRef.current,
    );

  const handleItemsDropped = async (entries: FileSystemEntry[]) => {
    let plan: UploadPlan;
    try {
      plan = await collectEntries(entries);
    } catch (error) {
      toast.error(errorText(error, t("containerFiles.uploadFailed")));
      return;
    }
    await uploadPlan(plan);
  };

  const pickInput = (folder: boolean) => {
    const input = document.createElement("input");
    input.type = "file";
    if (folder) input.setAttribute("webkitdirectory", "");
    else input.multiple = true;
    input.onchange = () => {
      if (!input.files?.length) return;
      if (folder) void uploadPlan(fromFileList(input.files));
      else handleFilesDropped(input.files);
    };
    input.click();
  };
  const pickFiles = () => pickInput(false);

  // ---- view -------------------------------------------------------------

  const visible = React.useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    const list = needle
      ? files.filter((f) => f.name.toLowerCase().includes(needle))
      : files.slice();
    const dir = sortOrder === "asc" ? 1 : -1;
    list.sort((a, b) => {
      if ((a.type === "directory") !== (b.type === "directory"))
        return a.type === "directory" ? -1 : 1;
      let r = 0;
      if (sortBy === "size") r = (a.size ?? 0) - (b.size ?? 0);
      else if (sortBy === "modified")
        r = (a.modifiedTimestamp ?? 0) - (b.modifiedTimestamp ?? 0);
      if (r === 0)
        r = a.name.localeCompare(b.name, undefined, { numeric: true });
      return r * dir;
    });
    return list;
  }, [files, searchQuery, sortBy, sortOrder]);

  const openMenu = (event: React.MouseEvent, file?: FileItem) => {
    event.preventDefault();
    const target = file
      ? selectedFiles.some((f) => f.path === file.path)
        ? selectedFiles
        : [file]
      : [];
    if (file && target.length === 1) setSelection(target);
    setMenu({ x: event.clientX, y: event.clientY, files: target });
  };

  const stopped = !running;
  const capBanner = capabilityBanner(caps, t);
  const stoppedText = `${
    caps?.reason === "paused"
      ? execLimit(caps, t)
      : `${t("containerFiles.containerStopped")}.`
  } ${t("containerFiles.containerStoppedHint")}`;
  const bannerText = gone
    ? t("containerFiles.containerGone")
    : stopped
      ? stoppedText
      : (capBanner?.text ?? t("containerFiles.containerRunning"));
  const terminalBlockReason = gone
    ? t("containerFiles.containerGone")
    : inArchive
      ? t("containerFiles.terminalInArchive")
      : featureBlock(caps, "terminal", t);
  const detail = listingDetail(caps, t);
  const stripTooltip = detail ? `${bannerText}\n${detail}` : undefined;
  // Extend this list to add more buttons to the strip.
  const panelButtons: PanelButton[] = [
    {
      id: "terminal",
      label: t("containerFiles.terminalHere"),
      icon: <Terminal className="size-3.5" />,
      disabled: gone || stopped || !!terminalBlockReason,
      title:
        terminalBlockReason ??
        (stopped
          ? t("containerFiles.terminalNeedsRunning")
          : t("fileManager.openTerminalHere")),
      onClick: () => void requestTerminal(containingDirectory(pathRef.current)),
    },
  ];

  return (
    <div
      ref={rootRef}
      data-fm-pane=""
      className="relative h-full min-h-0 w-full flex-1"
    >
      <div
        className="absolute inset-0 flex flex-col overflow-hidden bg-background"
        style={{ opacity: isVisible ? 1 : 0 }}
      >
        <FileManagerToolbar
          t={t as (key: string) => string}
          currentPath={currentPath}
          navIndex={historyIndex}
          navHistoryLength={history.length}
          isLoading={isLoading}
          sshSessionId={key}
          selectedFiles={selectedFiles}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          viewMode={viewMode}
          setViewMode={setViewMode}
          density={density}
          setDensity={setDensity}
          sortBy={sortBy}
          setSortBy={setSortBy}
          sortOrder={sortOrder}
          setSortOrder={setSortOrder}
          setMobileSidebarOpen={() => {}}
          sidebarOpen={tree.open}
          onToggleSidebar={() => tree.setOpen(!tree.open)}
          goBack={goBack}
          goForward={goForward}
          goUp={goUp}
          navigateTo={(p) => navigateTo(p)}
          handleRefreshDirectory={() => void load(pathRef.current)}
          handleDeleteFiles={(f) => void handleDelete(f)}
          handleCopyFiles={handleCopy}
          handleFilesDropped={handleFilesDropped}
          handleCreateNewFolder={() => startCreate("directory")}
          handleCreateNewFile={() => startCreate("file")}
        />
        <div className="flex min-h-0 flex-1">
          {tree.open && !inArchive && (
            <ContainerFolderTree
              nodes={tree.nodes}
              expanded={tree.expanded}
              currentPath={currentPath}
              width={tree.width}
              onWidth={tree.setWidth}
              onToggle={tree.toggle}
              onLoad={(p) => void tree.load(p)}
              onNavigate={(p) => navigateTo(p)}
              parsePaths={parseInternalFiles}
              onDropPaths={(paths, dest) => {
                const items = filesRef.current.filter((f) =>
                  paths.includes(f.path),
                );
                if (items.length > 0)
                  void handleFileDrop(items, {
                    ...items[0],
                    name: dest,
                    path: dest,
                    type: "directory",
                  });
              }}
            />
          )}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {loadError && (
              // Below the column header, which stays visible.
              <div className="absolute inset-x-0 bottom-0 top-9 z-10 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center text-sm text-destructive">
                <span>{loadError}</span>
                <button
                  className="border border-border px-3 py-1 text-xs text-foreground hover:bg-muted/40"
                  onClick={() => void load(pathRef.current)}
                >
                  {t("containers.refresh")}
                </button>
              </div>
            )}
            <FileManagerGrid
              files={loadError ? [] : visible}
              selectedFiles={selectedFiles}
              onFileOpen={(f) => void handleOpen(f)}
              onSelectionChange={setSelection}
              onRefresh={() => void load(pathRef.current)}
              onUpload={handleFilesDropped}
              onUploadItems={(e) => void handleItemsDropped(e)}
              onDownload={(f) => void handleDownload(f)}
              onContextMenu={openMenu}
              viewMode={viewMode}
              density={density}
              onRename={(f, n) => void handleRename(f, n)}
              editingFile={editingFile}
              onStartEdit={(f) => guardWrite("rename") && setEditingFile(f)}
              onCancelEdit={() => setEditingFile(null)}
              onDelete={(f) => void handleDelete(f)}
              onCopy={handleCopy}
              onCut={handleCut}
              onPaste={() => void handlePaste()}
              onFileDrop={(d, target) => void handleFileDrop(d, target)}
              hasClipboard={!!clipboard || !!bridge?.hasClipboard}
              createIntent={createIntent}
              onConfirmCreate={(n) => void confirmCreate(n)}
              onCancelCreate={() => setCreateIntent(null)}
              onNewFile={() => startCreate("file")}
              onNewFolder={() => startCreate("directory")}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSortChange={(field) => {
                if (field === sortBy)
                  setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
                else {
                  setSortBy(field);
                  setSortOrder("asc");
                }
              }}
              parentPath={currentPath === "/" ? null : parentOf(currentPath)}
              onNavigateUp={goUp}
              scrollResetKey={currentPath}
            />
            {(truncated || isVirtualPath(currentPath)) && (
              <div className="absolute bottom-0 left-0 right-0 border-t border-border bg-card/90 px-3 py-1 text-[11px] text-muted-foreground">
                {isVirtualPath(currentPath) && (
                  <div>{t("containerFiles.archiveBanner")}</div>
                )}
                {truncated && (
                  <div>
                    {t(
                      isVirtualPath(currentPath)
                        ? "containerFiles.archiveTruncated"
                        : "containerFiles.truncated",
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <FileManagerContextMenu
          x={menu?.x ?? 0}
          y={menu?.y ?? 0}
          files={menu?.files ?? []}
          isVisible={!!menu}
          onClose={() => setMenu(null)}
          currentPath={currentPath}
          hasClipboard={!!clipboard || !!bridge?.hasClipboard}
          onDownload={(f) => void handleDownload(f)}
          onRename={(f) => guardWrite("rename") && setEditingFile(f)}
          onCopy={handleCopy}
          onCut={handleCut}
          onDelete={(f) => void handleDelete(f)}
          onProperties={openPermissionsWindow}
          extraItems={linkMenuItems(menu?.files ?? [])}
          onOpenTerminal={
            inArchive ? undefined : (p) => void requestTerminal(p)
          }
          onUpload={pickFiles}
          onNewFolder={() => startCreate("directory")}
          onNewFile={() => startCreate("file")}
          onRefresh={() => void load(pathRef.current)}
          onPaste={() => void handlePaste()}
          onPreview={(f) => void handleOpen(f)}
          onCompress={openCompress}
          onExtractArchive={(f) => void handleExtract(f)}
          onCopyPath={(f) => {
            void navigator.clipboard
              ?.writeText(f.map((x) => x.path).join("\n"))
              .then(() => toast.success(t("containerFiles.pathCopied")));
          }}
        />

        <StatusStrip
          text={bannerText}
          tooltip={stripTooltip}
          tone={gone ? "error" : stopped || capBanner ? "warn" : "neutral"}
          alert={gone || stopped}
          buttons={panelButtons}
        />
      </div>
    </div>
  );
}

export function ContainerFileManager(props: Props): React.ReactElement {
  // In a workspace the windows are shared and managed one level up.
  if (props.bridge) return <Inner {...props} />;
  return (
    <WindowManager>
      <Inner {...props} />
    </WindowManager>
  );
}

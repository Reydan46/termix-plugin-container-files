import React from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { createPortal } from "react-dom";
import {
  Computer,
  GripVertical,
  Monitor,
  Move,
  Plus,
  Replace,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { WindowManager } from "../vendor/file-manager/components/WindowManager";
import { ContainerFileManager } from "../ContainerFileManager";
import { LocalFileManager } from "../LocalFileManager";
import { isLocalFileBrowserAvailable } from "../vendor/file-manager/lib/local-files";
import { ContainerList, StateBadge } from "../containers/ContainerList";
import type { ContainerLiveState } from "../containerFsApi";
import { containerName, type ContainerInfo } from "../types";
import {
  MAX_PANES,
  computeRects,
  computeSplitters,
  absorbArea,
  absorbTarget,
  type LayoutNode,
  type Rect,
  type Splitter,
  emptyIds,
  dropPreview,
  resolveDrop,
  type DropTarget,
  type WorkspaceZone,
  emptyLayout,
  layoutReducer,
  readSessionLayout,
  writeSessionLayout,
  paneStateKey,
  parseLayout,
  parsePaneState,
  readStored,
  serializeLayout,
  writeStored,
  type ContainerPane,
  type Layout,
  type Pane,
  type PaneViewState,
} from "./layout";
import {
  clearActiveDrag,
  getActiveDrag,
  parseInternalFiles,
  setActiveDrag,
} from "./dragRegistry";
import {
  ARCHIVE_ENTRIES_MIME,
  clearArchiveDrag,
  getArchiveDrag,
  type ArchiveDrag,
} from "./archiveDragRegistry";
import { isVirtualPath } from "../archivePath";
import { targetKey } from "../containerFsApi";
import { originOfSession } from "../sessionOrigin";
import { useArchiveExtract } from "../useArchiveExtract";
import { baseName } from "./conflicts";
import { localBaseName, parseLocalFiles } from "./localPaths";
import { useWorkspaceTransfers } from "./useWorkspaceTransfers";
import { decideDragEnd, hasPaneDrag, startPaneDrag } from "./paneDrag";
import type { PaneApi, PaneBridge } from "./types";
import {
  clipboardTimes,
  clipboardWinner,
  explorerPasteAction,
  markInternalClipboard,
  samePaths,
  supportsOsFileClipboard,
} from "../osClipboard";
import { localPlatform, readExplorerClipboard } from "../osClipboardApi";
import { clipboardErrorText } from "../osClipboardErrors";
import {
  clearOsClipboardAfterCut,
  copyLocalToOsClipboard,
  supersedeOsCopy,
} from "../osClipboardCopy";
import {
  afterPaste,
  cutPaths,
  makeClipboard,
  pasteKind,
  resolvePasteTarget,
  type ClipItem,
  type ClipMode,
  type PaneClipboard,
} from "./clipboard";

interface WorkspaceProps {
  sessionId: string;
  hostId: number | string;
  containers: ContainerInfo[];
  /** The container the user just picked in the list. */
  initialContainerId: string;
  isVisible: boolean;
  /** Element in the tab's title row that receives the "add pane" button. */
  actionsHost?: HTMLElement | null;
  onContainerState: (id: string, state: ContainerLiveState | null) => void;
  /** Called after a container action in a picker pane. */
  onChanged: (id: string, live: ContainerLiveState | null) => void;
  /** True while a pane shows the picker (the parent keeps the list fresh). */
  onListNeeded: (needed: boolean) => void;
  /** The last pane was closed. */
  onEmpty: () => void;
}

function initLayout(props: WorkspaceProps): Layout {
  let layout = parseLayout(readSessionLayout(props.sessionId));
  // The web build has no local disk: drop a local pane left by a desktop layout.
  if (!isLocalFileBrowserAvailable()) {
    for (const p of layout.panes)
      if (p.kind === "local")
        layout = layoutReducer(layout, { type: "close", id: p.id });
  }
  if (props.containers.length > 0) {
    layout = layoutReducer(layout, {
      type: "prune",
      existing: new Set(props.containers.map((c) => c.id)),
    });
  }
  return layoutReducer(layout, {
    type: "open",
    containerId: props.initialContainerId,
  });
}

function WorkspaceInner(props: WorkspaceProps) {
  const { t } = useTranslation();
  const { sessionId, hostId, containers } = props;
  const [layout, dispatch] = React.useReducer(
    layoutReducer,
    props,
    (p) => initLayout(p) ?? emptyLayout(),
  );
  const [clip, setClipState] = React.useState<PaneClipboard | null>(null);
  const clipRef = React.useRef<PaneClipboard | null>(null);
  const setClip = (value: PaneClipboard | null) => {
    clipRef.current = value;
    setClipState(value);
  };
  /**
   * Every Copy or Cut (any pane, keys, menu or toolbar) goes through here: it
   * stamps the clipboard as the newest, so a Ctrl+V pastes what was copied
   * last, and stops a container copy that is still being prepared for the OS
   * clipboard from landing after it.
   */
  const putClip = (value: PaneClipboard | null) => {
    markInternalClipboard();
    supersedeOsCopy();
    setClip(value);
  };
  const apis = React.useRef(new Map<string, PaneApi>());
  const paneByContainer = React.useRef(layout.panes);
  paneByContainer.current = layout.panes;
  const containersRef = React.useRef(containers);
  containersRef.current = containers;
  const initialState = React.useRef(new Map<string, PaneViewState>());

  React.useEffect(() => {
    writeSessionLayout(sessionId, serializeLayout(layout));
  }, [sessionId, layout]);

  const needsList = layout.panes.some((p) => p.containerId === null);
  React.useEffect(() => {
    props.onListNeeded(needsList);
    return () => props.onListNeeded(false);
  }, [needsList]);

  const empty = layout.panes.length === 0;
  React.useEffect(() => {
    if (empty) props.onEmpty();
  }, [empty]);

  const desktop = isLocalFileBrowserAvailable();
  const [localToken, setLocalToken] = React.useState(0);

  const label = (id: string | null) => {
    if (id === null) return t("local.pane");
    const c = containersRef.current.find((x) => x.id === id);
    return c ? containerName(c) : id.slice(0, 12);
  };

  const { transfer } = useWorkspaceTransfers({
    sessionId,
    containerLabel: label,
    refreshContainers: (ids) => {
      for (const pane of paneByContainer.current) {
        if (pane.kind === "local") {
          if (ids.includes(null)) setLocalToken((n) => n + 1);
        } else if (pane.containerId && ids.includes(pane.containerId))
          apis.current.get(pane.id)?.refresh();
      }
    },
  });

  const extractEntries = useArchiveExtract();

  // A drag that ends anywhere must not leave a stale archive drag behind.
  React.useEffect(() => {
    const clear = () => clearArchiveDrag();
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  // Archive entries dropped on a pane: extract into the dropped-on folder, but
  // only inside the container the archive lives in.
  const dropArchive = async (
    drag: ArchiveDrag,
    targetPaneId: string,
    dir: string,
  ) => {
    if (paneContainer(targetPaneId) !== drag.containerId) {
      toast.error(t("containerFiles.archiveOtherContainer"));
      return;
    }
    if (isVirtualPath(dir)) {
      toast.error(t("containerFiles.archiveReadOnly"));
      return;
    }
    const ok = await extractEntries(
      targetKey(sessionId, drag.containerId),
      drag.archive,
      drag.entries,
      dir,
    );
    if (ok) apis.current.get(targetPaneId)?.refresh();
  };

  const paneContainer = (paneId: string) =>
    paneByContainer.current.find((p) => p.id === paneId)?.containerId ?? null;

  /** The container of a pane; null for a local or picker pane. */
  const isLocalPane = (paneId: string) =>
    paneByContainer.current.find((p) => p.id === paneId)?.kind === "local";

  const dropInto = async (
    sourcePaneId: string,
    sourceContainerId: string | null,
    paths: string[],
    targetPaneId: string,
    dir: string,
    move: boolean,
  ) => {
    const targetLocal = isLocalPane(targetPaneId);
    const target = targetLocal ? null : paneContainer(targetPaneId);
    const source = apis.current.get(sourcePaneId);
    if (!targetLocal && !target) return;
    const ok = await transfer({
      from: {
        containerId: sourceContainerId,
        items: paths.map((path) => ({
          path,
          name:
            sourceContainerId === null ? localBaseName(path) : baseName(path),
          isDirectory: source?.isDirectory(path) ?? false,
        })),
      },
      to: { containerId: target, dir },
      move,
    });
    return ok;
  };

  /** "Upload to server" of the local pane: into the active container pane. */
  const uploadFromLocal = async (localPaths: string[], localPaneId: string) => {
    const container =
      layout.panes.find(
        (p) =>
          p.id === layout.activeId && p.kind === "container" && p.containerId,
      ) ?? layout.panes.find((p) => p.kind === "container" && p.containerId);
    const api = container ? apis.current.get(container.id) : undefined;
    if (
      !container ||
      container.kind !== "container" ||
      !container.containerId ||
      !api
    ) {
      toast.error(t("local.noContainerPane"));
      return;
    }
    await dropInto(
      localPaneId,
      null,
      localPaths,
      container.id,
      api.getDir(),
      false,
    );
  };

  /** Pastes the workspace clipboard into `dir` of the pane `destPaneId`. */
  const pasteInto = async (destPaneId: string, dir: string) => {
    const c = clipRef.current;
    const destContainer = isLocalPane(destPaneId)
      ? null
      : paneContainer(destPaneId);
    const kind = pasteKind(c, {
      paneId: destPaneId,
      containerId: destContainer,
    });
    if (!c || kind === "none" || kind === "own") return;
    if (kind === "unsupported") {
      toast.error(t("containerFiles.localToLocal"));
      return;
    }
    const ok = await transfer({
      from: { containerId: c.containerId, items: c.items },
      to: { containerId: destContainer, dir },
      move: c.mode === "cut",
      // The paste is the confirmation: a cut from this computer goes to the trash.
      trashLocalSource: true,
    });
    // Only the clipboard that was pasted may be cleared, not a newer one.
    if (clipRef.current === c) setClip(afterPaste(c, ok));
    // The files of a pasted Cut are gone: the OS clipboard must not list them.
    if (ok && c.mode === "cut" && c.containerId === null) {
      void clearOsClipboardAfterCut(c.items.map((i) => i.path));
    }
  };

  /**
   * Paste in the local pane. When Explorer copied after the workspace
   * clipboard was set, the OS clipboard is the newest: those files are on this
   * computer already, so there is nothing to transfer (local to local).
   */
  const pasteIntoLocal = async (paneId: string, dir: string) => {
    const c = clipRef.current;
    if (
      c &&
      clipboardWinner({ hasInternal: true, ...clipboardTimes() }) === "os"
    ) {
      try {
        if (supportsOsFileClipboard(await localPlatform())) {
          const { files, own } = await readExplorerClipboard();
          const local =
            c.containerId === null ? c.items.map((i) => i.path) : null;
          const action = explorerPasteAction({
            fileCount: files.length,
            own,
            hasInternal: true,
            matchesInternal:
              !!local &&
              samePaths(
                files.map((f) => f.path),
                local,
              ),
          });
          if (action === "upload") {
            toast.error(t("containerFiles.localToLocal"));
            return;
          }
        }
      } catch (error) {
        toast.error(
          t("containerFiles.osClipboardReadFailed", {
            error: clipboardErrorText(error, t),
          }),
        );
        return;
      }
      if (clipRef.current !== c) return;
    }
    await pasteInto(paneId, dir);
  };

  const localClipboard = (paneId: string) => ({
    cutPaths: cutPaths(clip, paneId),
    canPaste: !!clip,
    set: (items: ClipItem[], mode: ClipMode) => {
      putClip(makeClipboard(paneId, null, items, mode));
      // Desktop on Windows: Explorer sees the real files too, and the OS
      // clipboard no longer holds an older container copy.
      void copyLocalToOsClipboard({ t, paths: items.map((i) => i.path) });
    },
    paste: (dir: string) => void pasteIntoLocal(paneId, dir),
    clear: () => setClip(null),
    active: !!clip,
  });

  const makeBridge = (
    pane: ContainerPane & { containerId: string },
  ): PaneBridge => {
    const stateKey = paneStateKey(hostId, pane.containerId);
    let initial = initialState.current.get(`${pane.id}|${pane.containerId}`);
    if (!initial) {
      initial = parsePaneState(readStored(stateKey));
      initialState.current.set(`${pane.id}|${pane.containerId}`, initial);
    }
    return {
      paneId: pane.id,
      initial,
      saveState: (state) => writeStored(stateKey, JSON.stringify(state)),
      register: (api) => {
        if (api) apis.current.set(pane.id, api);
        else apis.current.delete(pane.id);
      },
      setClipboard: (items, cut) => {
        putClip(
          makeClipboard(
            pane.id,
            pane.containerId,
            items.map((f) => ({
              path: f.path,
              name: f.name,
              isDirectory: f.type === "directory",
            })),
            cut ? "cut" : "copy",
          ),
        );
      },
      hasClipboard: !!clip && clip.paneId !== pane.id,
      localClipboardPaths: () => {
        const c = clipRef.current;
        return c && c.containerId === null ? c.items.map((i) => i.path) : null;
      },
      cutPaths: cutPaths(clip, pane.id),
      ownsClipboard: clip?.paneId === pane.id,
      clearClipboard: () => setClip(null),
      paste: async (destDir) => {
        const c = clipRef.current;
        const kind = pasteKind(c, {
          paneId: pane.id,
          containerId: pane.containerId,
        });
        if (kind === "none") return false;
        if (kind === "own") {
          if (c?.mode === "cut") setClip(null);
          return false;
        }
        // A single selected folder is the target, like dropping on it.
        const selection = (apis.current.get(pane.id)?.getSelection() ?? []).map(
          (f) => ({ path: f.path, isDirectory: f.type === "directory" }),
        );
        await pasteInto(pane.id, resolvePasteTarget(destDir, selection));
        return true;
      },
      pasteLocalPaths: (destDir, items) =>
        transfer({
          from: { containerId: null, items },
          to: { containerId: pane.containerId, dir: destDir },
          move: false,
        }),
    };
  };

  const canAdd = layout.panes.length < MAX_PANES;
  const hasLocal = layout.panes.some((p) => p.kind === "local");
  const rects = computeRects(layout.tree);
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [drop, setDrop] = React.useState<DropTarget | null>(null);
  /** Whole area a dragged splitter's pane will take by absorbing the empty slot. */
  const [absorbRect, setAbsorbRect] = React.useState<Rect | null>(null);
  const areaRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!dragId) setDrop(null);
  }, [dragId]);
  // A pane drag that ends anywhere (even outside the window) must clear.
  React.useEffect(() => {
    const clear = () => setDragId(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);
  /**
   * What a drop at a client position does. `outside` says the pointer left
   * the window altogether (no coordinates are reliable then).
   */
  const dropAt = (x: number, y: number, outside = false): DropTarget | null => {
    if (!dragId) return null;
    if (outside) return resolveDrop(layout, dragId, -1, -1);
    const r = areaRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0)
      return { kind: "zone", zone: "right" };
    return resolveDrop(
      layout,
      dragId,
      (x - r.left) / r.width,
      (y - r.top) / r.height,
    );
  };
  const sameDrop = (a: DropTarget | null, b: DropTarget | null) =>
    JSON.stringify(a) === JSON.stringify(b);
  // The overlay only covers the workspace. A lone pane dragged past its edge
  // (over the tab bar, or out of the window) must still be seen, so while a
  // pane drag runs the window itself watches the pointer.
  const dropAtRef = React.useRef(dropAt);
  dropAtRef.current = dropAt;
  const dispatchRef = React.useRef(dispatch);
  dispatchRef.current = dispatch;
  // What the running pane drag knows, outside React state: the target the
  // preview last showed, whether something already applied the drag, and Esc.
  const session = React.useRef<{
    last: DropTarget | null;
    handled: boolean;
    cancelled: boolean;
  }>({ last: null, handled: false, cancelled: false });
  const commitRef = React.useRef<(target: DropTarget | null) => void>(() => {});
  React.useEffect(() => {
    if (!dragId) return;
    const id = dragId;
    const s = session.current;
    s.last = null;
    s.handled = false;
    s.cancelled = false;
    const commit = (target: DropTarget | null) => {
      if (s.handled) return;
      s.handled = true;
      s.last = null;
      setDrop(null);
      if (target) dispatchRef.current({ type: "drop", id, target });
    };
    commitRef.current = commit;
    const show = (target: DropTarget | null) => {
      s.last = target;
      setDrop((prev) => (sameDrop(prev, target) ? prev : target));
    };
    // Capture phase on purpose: the window's own "clear" listeners and the
    // handlers React puts on the root run later and may tear this effect down
    // (or stop the event) before a bubbling listener would be called.
    const over = (e: DragEvent) => {
      if (!hasPaneDrag(e.dataTransfer?.types)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      show(dropAtRef.current(e.clientX, e.clientY));
    };
    const leave = (e: DragEvent) => {
      const gone =
        e.relatedTarget === null &&
        (e.clientX <= 0 ||
          e.clientY <= 0 ||
          e.clientX >= window.innerWidth - 1 ||
          e.clientY >= window.innerHeight - 1);
      if (gone) show(dropAtRef.current(0, 0, true));
    };
    // Dropped on the page outside the overlay (e.g. the tab bar).
    const onDrop = (e: DragEvent) => {
      if (!hasPaneDrag(e.dataTransfer?.types)) return;
      e.preventDefault();
      commit(dropAtRef.current(e.clientX, e.clientY));
    };
    // Released where the browser sends no drop (outside the window, or over
    // something that took the event): only dragend arrives. The release
    // applies what the preview was showing.
    const end = () => commit(decideDragEnd({ ...s }));
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      s.cancelled = true;
      s.last = null;
      setDrop(null);
    };
    window.addEventListener("dragover", over, true);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", onDrop, true);
    window.addEventListener("dragend", end, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", onDrop, true);
      window.removeEventListener("dragend", end, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [dragId]);
  const preview = dragId && drop ? dropPreview(layout, dragId, drop) : null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {props.actionsHost &&
        createPortal(
          <AddPaneMenu
            canAdd={canAdd}
            desktop={desktop}
            onContainer={() => dispatch({ type: "add", containerId: null })}
            onLocal={() => dispatch({ type: "addLocal" })}
          />,
          props.actionsHost,
        )}
      <div ref={areaRef} className="relative min-h-0 flex-1 bg-border">
        {layout.panes.map((pane) => (
          <PaneFrame
            key={pane.id}
            pane={pane}
            rect={rects.get(pane.id)}
            onDragPane={setDragId}
            container={
              containers.find((c) => c.id === pane.containerId) ?? null
            }
            onActivate={() => dispatch({ type: "activate", id: pane.id })}
            onClose={() => dispatch({ type: "close", id: pane.id })}
            onChange={() =>
              dispatch({ type: "setContainer", id: pane.id, containerId: null })
            }
            canMove={layout.panes.length > 1}
            onMove={(zone) => dispatch({ type: "dock", id: pane.id, zone })}
            getApi={() => apis.current.get(pane.id)}
            onDropArchive={(drag, dir) => void dropArchive(drag, pane.id, dir)}
            onDropFiles={(drag, dir, move) =>
              void dropInto(
                drag.paneId,
                drag.containerId,
                drag.paths,
                pane.id,
                dir,
                move,
              )
            }
          >
            {pane.kind === "local" ? (
              <div className="h-full min-h-0">
                <LocalFileManager
                  refreshToken={localToken}
                  onRemoteItemsDropped={(_remotePaths, localDir) => {
                    // The grid does not name its pane: the drag registry does.
                    const drag = getActiveDrag();
                    clearActiveDrag();
                    if (!drag || drag.containerId === null) return;
                    void dropInto(
                      drag.paneId,
                      drag.containerId,
                      drag.paths,
                      pane.id,
                      localDir,
                      false,
                    );
                  }}
                  clipboard={localClipboard(pane.id)}
                  onUploadToRemote={(paths) =>
                    void uploadFromLocal(paths, pane.id)
                  }
                />
              </div>
            ) : pane.containerId === null ? (
              <div className="h-full overflow-y-auto p-2">
                <ContainerList
                  sessionId={sessionId}
                  onChanged={props.onChanged}
                  containers={containers}
                  columns="auto"
                  onSelectContainer={(id) =>
                    dispatch({
                      type: "setContainer",
                      id: pane.id,
                      containerId: id,
                    })
                  }
                  search=""
                  statusFilter="all"
                />
              </div>
            ) : (
              <ContainerFileManager
                key={`${pane.id}|${pane.containerId}`}
                sessionId={sessionId}
                containerId={pane.containerId}
                container={
                  containers.find((c) => c.id === pane.containerId) ?? null
                }
                isVisible={props.isVisible}
                origin={originOfSession(sessionId)}
                onStateChange={(state) =>
                  pane.containerId &&
                  props.onContainerState(pane.containerId, state)
                }
                bridge={makeBridge({ ...pane, containerId: pane.containerId })}
              />
            )}
          </PaneFrame>
        ))}
        {emptyIds(layout.tree).map((id) => {
          const r = rects.get(id);
          return (
            <div
              key={id}
              className="absolute flex items-center justify-center bg-background"
              style={{
                left: `calc(${(r?.x ?? 0) * 100}% + 0.5px)`,
                top: `calc(${(r?.y ?? 0) * 100}% + 0.5px)`,
                width: `calc(${(r?.w ?? 1) * 100}% - 1px)`,
                height: `calc(${(r?.h ?? 1) * 100}% - 1px)`,
              }}
            >
              <button
                type="button"
                className="absolute right-2 top-2 p-0.5 text-muted-foreground hover:text-foreground"
                title={t("workspace.closeEmpty")}
                aria-label={t("workspace.closeEmpty")}
                onClick={() => dispatch({ type: "closeEmpty", id })}
              >
                <X className="size-3.5" />
              </button>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className="flex items-center gap-1 border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!canAdd}
                  title={
                    canAdd
                      ? t("workspace.addContainer")
                      : t("workspace.maxPanes")
                  }
                  onClick={() =>
                    dispatch({ type: "add", containerId: null, emptyId: id })
                  }
                >
                  <Plus className="size-3.5" />
                  {t("workspace.addContainer")}
                </button>
                {desktop && !hasLocal && (
                  <button
                    type="button"
                    className="flex items-center gap-1 border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!canAdd}
                    onClick={() => dispatch({ type: "addLocal", emptyId: id })}
                  >
                    <Monitor className="size-3.5" />
                    {t("local.addLocal")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {computeSplitters(layout.tree).map((s) => (
          <SplitterHandle
            key={s.key}
            splitter={s}
            tree={layout.tree}
            areaRef={areaRef}
            onAbsorbPreview={setAbsorbRect}
            onAbsorb={() =>
              dispatch({ type: "absorb", path: s.path, index: s.index })
            }
            onMove={(position) =>
              dispatch({
                type: "resize",
                path: s.path,
                index: s.index,
                position,
              })
            }
            onReset={() => dispatch({ type: "resetRatios", path: s.path })}
          />
        ))}
        {absorbRect && (
          <div
            className="pointer-events-none absolute z-20 border-2 border-accent-brand bg-accent-brand/20"
            style={{
              left: `${absorbRect.x * 100}%`,
              top: `${absorbRect.y * 100}%`,
              width: `${absorbRect.w * 100}%`,
              height: `${absorbRect.h * 100}%`,
            }}
          />
        )}
        {dragId && (
          <div
            className="absolute inset-0 z-50"
            onDragEnter={(e) => e.preventDefault()}
            onDragOver={(e) => {
              if (!hasPaneDrag(e.dataTransfer.types)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const d = dropAt(e.clientX, e.clientY);
              session.current.last = d;
              if (!sameDrop(d, drop)) setDrop(d);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                session.current.last = null;
                setDrop(null);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // The window may have applied it already (first one wins).
              commitRef.current(dropAt(e.clientX, e.clientY));
              setDragId(null);
            }}
          >
            {preview?.rects.map((r, i) => (
              <div
                key={i}
                className={
                  preview.swap
                    ? "pointer-events-none absolute border-2 border-dashed border-amber-500 bg-amber-500/20"
                    : "pointer-events-none absolute border-2 border-accent-brand bg-accent-brand/20"
                }
                style={{
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.w * 100}%`,
                  height: `${r.h * 100}%`,
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Draggable boundary between two tiles; double-click restores equal shares. */
function SplitterHandle({
  splitter,
  tree,
  areaRef,
  onMove,
  onAbsorbPreview,
  onAbsorb,
  onReset,
}: {
  splitter: Splitter;
  tree: LayoutNode | null;
  areaRef: React.RefObject<HTMLDivElement | null>;
  onMove: (position: number) => void;
  /** The whole area the pane would take by absorbing the slot, else null. */
  onAbsorbPreview: (area: Rect | null) => void;
  /** Released past the threshold: the pane takes both areas. */
  onAbsorb: () => void;
  onReset: () => void;
}) {
  const { rect, offset, dir } = splitter;
  const row = dir === "row";
  const [dragging, setDragging] = React.useState(false);
  const absorbing = React.useRef<string | null>(null);
  const setAbsorbing = (id: string | null) => {
    if (absorbing.current === id) return;
    absorbing.current = id;
    onAbsorbPreview(
      id ? absorbArea(tree, splitter.path, splitter.index) : null,
    );
  };
  const THICK = 8;
  const move = (e: React.PointerEvent) => {
    const a = areaRef.current?.getBoundingClientRect();
    if (!a) return;
    const size = row ? a.width : a.height;
    const start = row ? rect.x : rect.y;
    const extent = row ? rect.w : rect.h;
    if (size <= 0 || extent <= 0) return;
    const frac =
      ((row ? e.clientX - a.left : e.clientY - a.top) / size - start) / extent;
    onMove(frac);
    setAbsorbing(absorbTarget(tree, splitter.path, splitter.index, frac));
  };
  return (
    <div
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      className={`absolute z-10 touch-none ${
        row ? "cursor-ew-resize" : "cursor-ns-resize"
      } ${dragging ? "bg-accent-brand/40" : "hover:bg-accent-brand/30"}`}
      style={
        row
          ? {
              left: `calc(${(rect.x + rect.w * offset) * 100}% - ${THICK / 2}px)`,
              top: `${rect.y * 100}%`,
              width: THICK,
              height: `${rect.h * 100}%`,
            }
          : {
              left: `${rect.x * 100}%`,
              top: `calc(${(rect.y + rect.h * offset) * 100}% - ${THICK / 2}px)`,
              width: `${rect.w * 100}%`,
              height: THICK,
            }
      }
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (dragging) move(e);
      }}
      onPointerUp={(e) => {
        const hit = absorbing.current;
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
        setAbsorbing(null);
        setDragging(false);
        if (hit) onAbsorb();
      }}
      onPointerCancel={() => {
        setAbsorbing(null);
        setDragging(false);
      }}
      onLostPointerCapture={() => {
        setAbsorbing(null);
        setDragging(false);
      }}
      onDoubleClick={onReset}
    />
  );
}

function PaneFrame({
  pane,
  rect,
  onDragPane,
  container,
  onActivate,
  onClose,
  onChange,
  canMove,
  onMove,
  getApi,
  onDropFiles,
  onDropArchive,
  children,
}: {
  canMove: boolean;
  onMove: (zone: WorkspaceZone) => void;
  pane: Pane;
  rect: { x: number; y: number; w: number; h: number } | undefined;
  onDragPane: (id: string | null) => void;
  container: ContainerInfo | null;
  onActivate: () => void;
  onClose: () => void;
  onChange: () => void;
  getApi: () => PaneApi | undefined;
  onDropFiles: (
    drag: { paneId: string; containerId: string | null; paths: string[] },
    dir: string,
    move: boolean,
  ) => void;
  onDropArchive: (drag: ArchiveDrag, dir: string) => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [over, setOver] = React.useState(false);
  const cancelStart = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => cancelStart.current?.(), []);

  const foreignDrag = () => {
    const drag = getActiveDrag();
    return drag &&
      drag.paneId !== pane.id &&
      pane.kind === "container" &&
      pane.containerId
      ? drag
      : null;
  };

  // Only an in-app archive drag counts: the DataTransfer must carry our MIME
  // type, so OS file drags are never hijacked by a stale registry entry.
  const archiveDrag = (e: React.DragEvent) =>
    pane.kind === "container" &&
    pane.containerId &&
    e.dataTransfer.types.includes(ARCHIVE_ENTRIES_MIME)
      ? getArchiveDrag()
      : null;
  const anyDrag = (e: React.DragEvent) => !!foreignDrag() || !!archiveDrag(e);
  return (
    <div
      style={{
        position: "absolute",
        left: `calc(${(rect?.x ?? 0) * 100}% + 0.5px)`,
        top: `calc(${(rect?.y ?? 0) * 100}% + 0.5px)`,
        width: `calc(${(rect?.w ?? 1) * 100}% - 1px)`,
        height: `calc(${(rect?.h ?? 1) * 100}% - 1px)`,
      }}
      className={`flex min-w-0 flex-col bg-background ${over ? "outline outline-2 -outline-offset-2 outline-accent-brand" : ""}`}
      onMouseDownCapture={onActivate}
      onFocusCapture={onActivate}
      onDragStart={(e) => {
        const raw = e.dataTransfer.getData("text/plain");
        if (pane.kind === "local") {
          const paths = parseLocalFiles(raw);
          if (paths.length > 0)
            setActiveDrag({ paneId: pane.id, containerId: null, paths });
          return;
        }
        const paths = parseInternalFiles(raw);
        if (paths.length > 0 && pane.containerId)
          setActiveDrag({
            paneId: pane.id,
            containerId: pane.containerId,
            paths,
          });
      }}
      onDragEnd={() => {
        clearActiveDrag();
        setOver(false);
      }}
      onDragEnterCapture={(e) => {
        if (!anyDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragOverCapture={(e) => {
        if (!anyDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        // A drag from this computer only allows "copy" (Chromium drops the
        // event otherwise).
        e.dataTransfer.dropEffect =
          e.shiftKey && !archiveDrag(e) && foreignDrag()?.containerId !== null
            ? "move"
            : "copy";
      }}
      onDragLeaveCapture={(e) => {
        if (!anyDrag(e)) return;
        e.stopPropagation();
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setOver(false);
      }}
      onDropCapture={(e) => {
        const drag = foreignDrag();
        const archive = drag ? null : archiveDrag(e);
        setOver(false);
        if (!drag && !archive) return;
        e.preventDefault();
        e.stopPropagation();
        clearActiveDrag();
        clearArchiveDrag();
        const api = getApi();
        if (!api) {
          toast.error(t("workspace.paneNotReady"));
          return;
        }
        const row = (e.target as HTMLElement).closest("[data-file-path]");
        const rowPath = row?.getAttribute("data-file-path");
        const dir =
          rowPath && api.isDirectory(rowPath) ? rowPath : api.getDir();
        if (archive) onDropArchive(archive, dir);
        else if (drag)
          onDropFiles(drag, dir, e.shiftKey && drag.containerId !== null);
      }}
    >
      <div
        className="flex shrink-0 cursor-grab items-center gap-2 border-b border-border px-2 py-1 text-xs active:cursor-grabbing"
        draggable
        title={t("workspace.dragPane")}
        onDragStart={(e) => {
          e.stopPropagation();
          // Never change the DOM inside dragstart: Chromium cancels the drag.
          cancelStart.current?.();
          cancelStart.current = startPaneDrag(
            e.dataTransfer,
            pane.id,
            onDragPane,
          );
        }}
        onDragEnd={() => {
          cancelStart.current?.();
          cancelStart.current = null;
          onDragPane(null);
        }}
      >
        <GripVertical className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {pane.kind === "local" ? (
            <span className="inline-flex items-center gap-1">
              <Monitor className="size-3.5" />
              {t("local.pane")}
            </span>
          ) : container ? (
            containerName(container)
          ) : pane.containerId ? (
            pane.containerId.slice(0, 12)
          ) : (
            t("workspace.pickContainer")
          )}
        </span>
        {container && <StateBadge state={container.state} />}
        {pane.containerId && (
          <button
            type="button"
            className="p-0.5 text-muted-foreground hover:text-foreground"
            title={t("workspace.changeContainer")}
            aria-label={t("workspace.changeContainer")}
            onClick={onChange}
          >
            <Replace className="size-3.5" />
          </button>
        )}
        {canMove && <MovePaneMenu onMove={onMove} />}
        <button
          type="button"
          className="p-0.5 text-muted-foreground hover:text-foreground"
          title={t("workspace.closePane")}
          aria-label={t("workspace.closePane")}
          onClick={onClose}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}

const MOVE_ZONES: WorkspaceZone[] = [
  "topLeft",
  "top",
  "topRight",
  "left",
  "right",
  "bottomLeft",
  "bottom",
  "bottomRight",
];

/** Drag-free way to dock a pane to a side or quarter of the workspace. */
function MovePaneMenu({ onMove }: { onMove: (zone: WorkspaceZone) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative" draggable={false}>
      <button
        type="button"
        className="p-0.5 text-muted-foreground hover:text-foreground"
        title={t("workspace.movePane")}
        aria-label={t("workspace.movePane")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Move className="size-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-40 border border-border bg-background shadow-md">
          {MOVE_ZONES.map((zone) => (
            <button
              key={zone}
              type="button"
              className="flex w-full items-center px-2 py-1 text-left text-xs hover:bg-muted/40"
              onClick={() => {
                setOpen(false);
                onMove(zone);
              }}
            >
              {t(`workspace.dock.${zone}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Add pane": a container, or (Desktop only) the local computer. */
function AddPaneMenu({
  canAdd,
  desktop,
  onContainer,
  onLocal,
}: {
  canAdd: boolean;
  desktop: boolean;
  onContainer: () => void;
  onLocal: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const item =
    "flex w-full items-center gap-1 px-2 py-1 text-left text-xs hover:bg-muted/40";
  return (
    <div ref={ref} className="relative flex items-center gap-1">
      {desktop && (
        <button
          type="button"
          className="flex items-center gap-1 border border-border px-2 py-0.5 text-xs hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canAdd}
          title={canAdd ? t("local.openLocal") : t("workspace.maxPanes")}
          onClick={onLocal}
        >
          <Computer className="size-3.5" />
          {t("local.addLocal")}
        </button>
      )}
      <button
        type="button"
        className="flex items-center gap-1 border border-border px-2 py-0.5 text-xs hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!canAdd}
        title={canAdd ? t("workspace.addPane") : t("workspace.maxPanes")}
        onClick={() => (desktop ? setOpen((v) => !v) : onContainer())}
      >
        <Plus className="size-3.5" />
        {t("workspace.addPane")}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-36 border border-border bg-background shadow-md">
          <button
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              onContainer();
            }}
          >
            <Plus className="size-3.5" />
            {t("local.addContainer")}
          </button>
          <button
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              onLocal();
            }}
          >
            <Monitor className="size-3.5" />
            {t("local.addLocal")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Up to MAX_PANES file managers side by side with one shared window manager.
 * A `local` pane (Desktop only) shows the user's own computer.
 */
export function ContainerWorkspace(props: WorkspaceProps): React.ReactElement {
  return (
    <div className="relative h-full min-h-0 w-full">
      <WindowManager>
        <WorkspaceInner {...props} />
      </WindowManager>
    </div>
  );
}

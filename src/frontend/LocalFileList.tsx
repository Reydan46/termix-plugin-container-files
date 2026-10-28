import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, cn } from "@termix-ssh/plugin-sdk/ui";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Code,
  CornerLeftUp,
  File,
  FileAudio,
  FileImage,
  FileSymlink,
  FileText,
  FileVideo,
  Folder,
  HardDrive,
  Home,
  Settings,
} from "lucide-react";
import {
  gridColumns,
  viewMetrics,
  type LocalDensity,
  type LocalViewMode,
} from "./localViewPrefs";
import type { LocalFileEntry } from "./vendor/file-manager/local-types";
import {
  describeLocalKind,
  formatLocalModified,
  type LocalSortField,
} from "./vendor/file-manager/local-transfer-utils";
import { formatFileSize } from "./vendor/file-manager/file-manager-utils";
import {
  useResizableColumns,
  type ResizableColumnSpec,
} from "./vendor/file-manager/hooks/useResizableColumns";
import { ColumnResizeHandle } from "./vendor/file-manager/components/ColumnResizeHandle";
import { ColumnVisibilityMenu } from "./vendor/file-manager/components/ColumnVisibilityMenu";

const COLUMNS_STORAGE_KEY = "termix:file-manager:columns:local";
const COLUMNS: ResizableColumnSpec[] = [
  {
    key: "modified",
    labelKey: "fileManager.modified",
    defaultWidth: 130,
    minWidth: 70,
  },
  { key: "size", labelKey: "fileManager.size", defaultWidth: 72, minWidth: 56 },
  { key: "kind", labelKey: "fileManager.kind", defaultWidth: 64, minWidth: 48 },
];

const IMAGE = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "ico",
]);
const VIDEO = new Set(["mp4", "mkv", "mov", "avi", "webm", "wmv"]);
const AUDIO = new Set(["mp3", "wav", "flac", "ogg", "m4a", "aac"]);
const ARCHIVE = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz"]);
const CODE = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rs",
  "java",
  "c",
  "h",
  "cpp",
  "cs",
  "rb",
  "php",
  "sh",
  "ps1",
  "html",
  "css",
  "scss",
  "sql",
]);
const CONFIG = new Set([
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "env",
  "xml",
]);
const TEXT = new Set(["txt", "md", "log", "csv", "pdf", "doc", "docx", "rtf"]);

/** Icon of an entry by type, then by extension. */
export function LocalEntryIcon({
  entry,
  drive,
  size = "size-4",
}: {
  entry: Pick<LocalFileEntry, "name" | "type">;
  drive?: boolean;
  /** Tailwind size class of the icon. */
  size?: string;
}): React.ReactElement {
  if (drive) return <HardDrive className={`${size} text-accent-brand`} />;
  if (entry.type === "directory")
    return <Folder className={`${size} text-accent-brand`} />;
  if (entry.type === "link")
    return <FileSymlink className={`${size} text-blue-400`} />;
  const dot = entry.name.lastIndexOf(".");
  const ext = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
  const cls = `${size} text-muted-foreground`;
  if (IMAGE.has(ext)) return <FileImage className={cls} />;
  if (VIDEO.has(ext)) return <FileVideo className={cls} />;
  if (AUDIO.has(ext)) return <FileAudio className={cls} />;
  if (ARCHIVE.has(ext)) return <Archive className={cls} />;
  if (CODE.has(ext)) return <Code className={cls} />;
  if (CONFIG.has(ext)) return <Settings className={cls} />;
  if (TEXT.has(ext)) return <FileText className={cls} />;
  return <File className={cls} />;
}

export interface InlineEdit {
  /** "folder" or "file" for a new entry; absent when renaming. */
  kind?: "folder" | "file";
  /** Path of the entry being renamed. */
  path?: string;
  name: string;
}

interface Props {
  entries: LocalFileEntry[];
  /** The entries are drives ("This PC"): no drag, rename or context menu. */
  drivesMode: boolean;
  /** Target of the pinned ".." row, or null when there is none. */
  parentPath: string | null;
  selected: ReadonlySet<string>;
  sortBy: LocalSortField;
  sortOrder: "asc" | "desc";
  onToggleSort: (field: LocalSortField) => void;
  loading: boolean;
  error: string | null;
  onHome: () => void;
  filtered: boolean;
  edit: InlineEdit | null;
  onEditChange: (name: string) => void;
  onEditSubmit: () => void;
  onEditCancel: () => void;
  /** Folder (or ".." target) highlighted as a drop target. */
  dropPath: string | null;
  onRowClick: (entry: LocalFileEntry, event: React.MouseEvent) => void;
  onRowContextMenu: (event: React.MouseEvent, entry?: LocalFileEntry) => void;
  onRowDragStart: (event: React.DragEvent, entry: LocalFileEntry) => void;
  onFolderDragOver: (event: React.DragEvent, entry: LocalFileEntry) => void;
  onFolderDragLeave: (event: React.DragEvent, entry: LocalFileEntry) => void;
  onFolderDrop: (event: React.DragEvent, entry: LocalFileEntry) => void;
  onGoUp: () => void;
  onBackgroundClick: () => void;
  viewMode: LocalViewMode;
  density: LocalDensity;
}

function EditInput({
  edit,
  onChange,
  onSubmit,
  onCancel,
  className,
}: {
  edit: InlineEdit;
  className: string;
  onChange: (name: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = edit.kind === "folder" ? -1 : edit.name.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : edit.name.length);
    // Only when the field appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <input
      ref={ref}
      value={edit.name}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onSubmit();
        if (e.key === "Escape") onCancel();
      }}
      onBlur={onSubmit}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      className={className}
    />
  );
}

/** Sortable, resizable, virtualised listing; same look as the container grid. */
export function LocalFileList(props: Props): React.ReactElement {
  const { t } = useTranslation();
  const columns = useResizableColumns({
    storageKey: COLUMNS_STORAGE_KEY,
    columns: COLUMNS,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const [columnMenu, setColumnMenu] = useState<{
    x: number;
    y: number;
    visible: boolean;
  }>({ x: 0, y: 0, visible: false });
  const [gridCols, setGridCols] = useState(4);

  const grid = props.viewMode === "grid";
  const compact = props.density === "compact";
  const metrics = viewMetrics(props.density);
  const listIcon = compact ? "size-4" : "size-6";
  const gridIcon = compact ? "size-6" : "size-8";

  // Same responsive column count as the container grid.
  useEffect(() => {
    if (!grid) return;
    const el = scrollRef.current;
    if (!el) return;
    const update = () =>
      setGridCols(gridColumns(el.clientWidth, props.density));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [grid, props.density]);

  const gridRowCount = grid ? Math.ceil(props.entries.length / gridCols) : 0;

  const listVirtualizer = useVirtualizer({
    count: grid ? 0 : props.entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => metrics.listRowHeight,
    overscan: 16,
    getItemKey: (index) => props.entries[index]?.path ?? index,
  });
  const gridVirtualizer = useVirtualizer({
    count: gridRowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => metrics.gridRowHeight,
    overscan: 6,
    getItemKey: (index) => `row-${index}`,
  });
  useLayoutEffect(() => {
    if (grid) gridVirtualizer.measure();
    else listVirtualizer.measure();
    // The list itself changes the stride only through these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, props.density, props.entries, gridCols]);

  // A new entry's field sits at the top of the list; bring it into view.
  const creatingNow = !!props.edit?.kind;
  useEffect(() => {
    if (creatingNow && scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [creatingNow]);

  const rowStyle = { gridTemplateColumns: columns.gridTemplateColumns };
  const rowBase = cn(
    "grid gap-2 items-center cursor-pointer border-l-2 border-transparent hover:bg-muted/50 rounded-none select-none transition-colors text-xs h-full box-border overflow-hidden",
    compact ? "px-3 py-1" : "px-3 py-2",
  );

  const sortIndicator = (field: LocalSortField) =>
    props.sortBy === field ? (
      props.sortOrder === "asc" ? (
        <ArrowUp className="size-3" />
      ) : (
        <ArrowDown className="size-3" />
      )
    ) : null;

  const headerCell = (
    field: LocalSortField,
    label: string,
    key?: string,
    right?: boolean,
  ) => (
    <div
      className={cn(
        "relative flex items-center gap-1 cursor-pointer hover:text-accent-brand transition-colors min-w-0",
        right && "justify-end",
      )}
      key={field}
      onClick={() => props.onToggleSort(field)}
    >
      {key && <ColumnResizeHandle {...columns.getHandleProps(key)} />}
      <span className="truncate">{label}</span>
      {sortIndicator(field)}
    </div>
  );

  const parentEntry: LocalFileEntry | null = props.parentPath
    ? {
        name: "..",
        path: props.parentPath,
        type: "directory",
        size: 0,
        hidden: false,
      }
    : null;

  const creating = props.edit?.kind ? props.edit : null;
  const renamingPath = props.edit?.path;

  const entryHandlers = (entry: LocalFileEntry) => {
    const isDirectory = entry.type === "directory";
    return {
      onClick: (e: React.MouseEvent) => {
        e.stopPropagation();
        props.onRowClick(entry, e);
      },
      onContextMenu: (e: React.MouseEvent) => {
        if (props.drivesMode) e.preventDefault();
        else props.onRowContextMenu(e, entry);
      },
      onDragStart: (e: React.DragEvent) => {
        if (props.drivesMode) e.preventDefault();
        else props.onRowDragStart(e, entry);
      },
      onDragOver: isDirectory
        ? (e: React.DragEvent) => props.onFolderDragOver(e, entry)
        : undefined,
      onDragLeave: isDirectory
        ? (e: React.DragEvent) => props.onFolderDragLeave(e, entry)
        : undefined,
      onDrop: isDirectory
        ? (e: React.DragEvent) => props.onFolderDrop(e, entry)
        : undefined,
    };
  };

  const parentHandlers = parentEntry
    ? {
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation();
          props.onGoUp();
        },
        onContextMenu: (e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
        },
        onDragOver: (e: React.DragEvent) =>
          props.onFolderDragOver(e, parentEntry),
        onDragLeave: (e: React.DragEvent) =>
          props.onFolderDragLeave(e, parentEntry),
        onDrop: (e: React.DragEvent) => props.onFolderDrop(e, parentEntry),
      }
    : null;
  const parentDrop =
    !!parentEntry &&
    props.dropPath === parentEntry.path &&
    "bg-accent-brand/20 border-accent-brand border-dashed";

  const parentListRow =
    parentEntry && parentHandlers && !props.error ? (
      <div
        data-parent-entry
        title={t("fileManager.goToParentFolder")}
        style={rowStyle}
        className={cn(
          "grid gap-2 items-center cursor-pointer border-l-2 border-transparent hover:bg-muted/50 rounded-none select-none transition-colors text-xs",
          compact ? "px-3 py-1" : "px-3 py-2",
          parentDrop,
        )}
        {...parentHandlers}
      >
        <div className="flex items-center gap-3 overflow-hidden pointer-events-none">
          <div className="shrink-0">
            <CornerLeftUp className="size-4 text-muted-foreground" />
          </div>
          <span className="font-medium text-muted-foreground">..</span>
        </div>
      </div>
    ) : null;

  const parentGridStrip =
    parentEntry && parentHandlers && !props.error ? (
      <div
        data-parent-entry
        title={t("fileManager.goToParentFolder")}
        className={cn(
          "flex items-center gap-2 rounded-none border border-transparent transition-colors cursor-pointer hover:bg-muted/50 select-none text-xs",
          compact ? "-mx-2 -mt-2 px-2 py-1" : "-mx-3 -mt-3 px-3 py-1.5",
          parentDrop,
        )}
        {...parentHandlers}
      >
        <CornerLeftUp className="size-3.5 text-muted-foreground pointer-events-none" />
        <span className="font-medium text-muted-foreground pointer-events-none">
          ..
        </span>
      </div>
    ) : null;

  const emptyState = (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground select-none pointer-events-none">
      <Folder className="size-8 text-muted-foreground/30" />
      <span className="text-xs">
        {props.drivesMode
          ? t("localFiles.drivesEmpty")
          : props.filtered
            ? t("localFiles.noMatches")
            : t("fileManager.emptyFolder")}
      </span>
    </div>
  );

  const errorState = (
    <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-xs font-semibold text-destructive">
        {t("fileManager.localCannotOpenFolder")}
      </p>
      <p className="max-w-full break-words font-mono text-[11px] text-muted-foreground">
        {props.error}
      </p>
      <Button variant="outline" size="sm" onClick={props.onHome}>
        <Home className="size-3.5" />
        {t("fileManager.localHome")}
      </Button>
    </div>
  );

  const nothing = props.entries.length === 0 && !creating;

  const listHeader = (
    <div
      className={cn(
        "grid gap-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70 border-b border-border bg-background",
        compact ? "px-3 py-1" : "px-3 py-2",
      )}
      style={rowStyle}
      title={t("fileManager.columnsHint")}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setColumnMenu({ x: e.clientX, y: e.clientY, visible: true });
      }}
    >
      {headerCell("name", t("fileManager.name"))}
      {columns.isVisible("modified") &&
        headerCell("modified", t("fileManager.modified"), "modified")}
      {columns.isVisible("size") &&
        headerCell("size", t("fileManager.size"), "size", true)}
      {columns.isVisible("kind") &&
        headerCell("kind", t("fileManager.kind"), "kind")}
    </div>
  );

  const renderName = (entry: LocalFileEntry) =>
    renamingPath === entry.path && props.edit ? (
      <EditInput
        edit={props.edit}
        onChange={props.onEditChange}
        onSubmit={props.onEditSubmit}
        onCancel={props.onEditCancel}
        className={cn(
          "flex-1 min-w-0 border border-accent-brand/60 bg-card px-2 py-0 text-xs rounded-none outline-none focus:ring-1 focus:ring-accent-brand/50 pointer-events-auto",
          compact ? "h-5" : "h-6",
        )}
      />
    ) : (
      <span className="font-medium truncate" title={entry.name}>
        {entry.name}
        {entry.type === "link" && entry.linkTarget && (
          <span className="text-accent-brand ml-1 normal-case font-normal">
            {"→ "}
            {entry.linkTarget}
          </span>
        )}
      </span>
    );

  const listBody = (
    <div className="flex flex-col">
      {listHeader}
      {parentListRow}
      {creating && (
        <div style={{ height: metrics.listRowHeight }}>
          <div className={cn(rowBase, "cursor-default")} style={rowStyle}>
            <div
              className={cn(
                "flex items-center overflow-hidden",
                compact ? "gap-2" : "gap-3",
              )}
            >
              <span className="shrink-0">
                <LocalEntryIcon
                  size={listIcon}
                  entry={{
                    name: creating.name,
                    type: creating.kind === "folder" ? "directory" : "file",
                  }}
                />
              </span>
              <EditInput
                edit={creating}
                onChange={props.onEditChange}
                onSubmit={props.onEditSubmit}
                onCancel={props.onEditCancel}
                className={cn(
                  "flex-1 min-w-0 border border-accent-brand/60 bg-card px-2 py-0 text-xs rounded-none outline-none focus:ring-1 focus:ring-accent-brand/50 pointer-events-auto",
                  compact ? "h-5" : "h-6",
                )}
              />
            </div>
          </div>
        </div>
      )}
      <div
        className="relative w-full"
        style={{ height: listVirtualizer.getTotalSize() }}
      >
        {listVirtualizer.getVirtualItems().map((vItem) => {
          const entry = props.entries[vItem.index];
          if (!entry) return null;
          const isSelected = props.selected.has(entry.path);
          const isDrop = props.dropPath === entry.path;
          const isDirectory = entry.type === "directory";
          const isEditing = renamingPath === entry.path;
          return (
            <div
              key={vItem.key}
              data-index={vItem.index}
              className="absolute top-0 left-0 w-full"
              style={{
                height: metrics.listRowHeight,
                transform: `translateY(${vItem.start}px)`,
              }}
            >
              <div
                data-local-path={entry.path}
                draggable={!props.drivesMode && !isEditing}
                style={{
                  gridTemplateColumns: isEditing
                    ? "minmax(0, 1fr)"
                    : columns.gridTemplateColumns,
                }}
                className={cn(
                  rowBase,
                  isSelected &&
                    "border-accent-brand bg-accent-brand/10 hover:bg-accent-brand/10",
                  isDrop &&
                    "bg-accent-brand/20 border-accent-brand border-dashed",
                  entry.hidden && "opacity-60",
                )}
                title={entry.path}
                {...entryHandlers(entry)}
              >
                <div
                  className={cn(
                    "flex items-center overflow-hidden pointer-events-none",
                    compact ? "gap-2" : "gap-3",
                    isEditing && "col-span-full",
                  )}
                >
                  <div className="shrink-0">
                    <LocalEntryIcon
                      size={listIcon}
                      entry={entry}
                      drive={props.drivesMode}
                    />
                  </div>
                  {renderName(entry)}
                </div>
                {!isEditing && columns.isVisible("modified") && (
                  <span className="text-[10px] text-muted-foreground truncate pointer-events-none">
                    {props.drivesMode
                      ? ""
                      : formatLocalModified(entry.modifiedTimestamp)}
                  </span>
                )}
                {!isEditing && columns.isVisible("size") && (
                  <span className="text-[10px] text-right text-muted-foreground tabular-nums truncate pointer-events-none">
                    {props.drivesMode
                      ? ""
                      : isDirectory
                        ? "-"
                        : formatFileSize(entry.size)}
                  </span>
                )}
                {!isEditing && columns.isVisible("kind") && (
                  <span className="text-[10px] text-muted-foreground truncate pointer-events-none">
                    {props.drivesMode
                      ? t("localFiles.drive")
                      : describeLocalKind(entry)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  const gridCellClass = (extra?: string) =>
    cn(
      "group flex flex-col items-center overflow-hidden rounded-none border border-border/40 bg-card/30 transition-colors select-none",
      compact ? "p-1.5" : "p-2",
      extra,
    );
  const gapClass = compact ? "gap-2" : "gap-3";
  const gridTemplate = {
    gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
  };

  const gridBody = (
    <div className={cn("flex flex-col", gapClass)}>
      {parentGridStrip}
      {creating && (
        <div className={cn("grid", gapClass)} style={gridTemplate}>
          <div className={gridCellClass("border-accent-brand/30")}>
            <div className={cn("relative", compact ? "mb-1" : "mb-2")}>
              <LocalEntryIcon
                size={gridIcon}
                entry={{
                  name: creating.name,
                  type: creating.kind === "folder" ? "directory" : "file",
                }}
              />
            </div>
            <EditInput
              edit={creating}
              onChange={props.onEditChange}
              onSubmit={props.onEditSubmit}
              onCancel={props.onEditCancel}
              className="max-w-[120px] min-w-[60px] w-fit border border-accent-brand/60 bg-card px-2 py-1 text-xs rounded-none outline-none focus:ring-1 focus:ring-accent-brand/50 text-center"
            />
          </div>
        </div>
      )}
      <div
        className="relative w-full"
        style={{ height: gridVirtualizer.getTotalSize() }}
      >
        {gridVirtualizer.getVirtualItems().map((vRow) => {
          const start = vRow.index * gridCols;
          const rowEntries = props.entries.slice(start, start + gridCols);
          return (
            <div
              key={vRow.key}
              data-index={vRow.index}
              className="absolute top-0 left-0 w-full"
              style={{
                height: metrics.gridRowHeight,
                transform: `translateY(${vRow.start}px)`,
              }}
            >
              <div
                className={cn("grid", gapClass)}
                style={{
                  ...gridTemplate,
                  gridAutoRows: metrics.gridRowHeight - metrics.gridGap,
                }}
              >
                {rowEntries.map((entry) => {
                  const isSelected = props.selected.has(entry.path);
                  const isDrop = props.dropPath === entry.path;
                  const isEditing = renamingPath === entry.path;
                  return (
                    <div
                      key={entry.path}
                      data-local-path={entry.path}
                      draggable={!props.drivesMode && !isEditing}
                      className={gridCellClass(
                        cn(
                          "cursor-pointer hover:bg-muted/50 hover:border-border",
                          isSelected &&
                            "bg-accent-brand/10 hover:bg-accent-brand/10 border-accent-brand/30",
                          isDrop &&
                            "bg-accent-brand/20 border-accent-brand border-dashed",
                          entry.hidden && "opacity-60",
                        ),
                      )}
                      title={entry.path}
                      {...entryHandlers(entry)}
                    >
                      <div
                        className={cn(
                          "relative pointer-events-none",
                          compact ? "mb-1" : "mb-2",
                        )}
                      >
                        <LocalEntryIcon
                          size={gridIcon}
                          entry={entry}
                          drive={props.drivesMode}
                        />
                      </div>
                      <div className="w-full flex flex-col items-center pointer-events-none">
                        {isEditing && props.edit ? (
                          <EditInput
                            edit={props.edit}
                            onChange={props.onEditChange}
                            onSubmit={props.onEditSubmit}
                            onCancel={props.onEditCancel}
                            className="max-w-[120px] min-w-[60px] w-fit border border-accent-brand/60 bg-card px-2 py-1 text-xs rounded-none outline-none focus:ring-1 focus:ring-accent-brand/50 text-center pointer-events-auto"
                          />
                        ) : (
                          <p
                            className="font-medium text-center truncate w-full px-1 text-[11px]"
                            title={entry.name}
                          >
                            {entry.name}
                          </p>
                        )}
                        {entry.type === "file" && !props.drivesMode && (
                          <p className="text-[10px] font-medium text-muted-foreground/60 mt-0.5">
                            {formatFileSize(entry.size)}
                          </p>
                        )}
                        {entry.type === "link" && entry.linkTarget && (
                          <p
                            className="text-[10px] text-accent-brand mt-0.5 truncate w-full text-center"
                            title={entry.linkTarget}
                          >
                            {"→ "}
                            {entry.linkTarget}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (props.error) {
    body = errorState;
  } else if (nothing) {
    body = (
      <div className="h-full flex flex-col">
        {grid ? parentGridStrip : null}
        {grid ? null : (
          <>
            {listHeader}
            {parentListRow}
          </>
        )}
        {props.loading ? null : emptyState}
      </div>
    );
  } else {
    body = grid ? gridBody : listBody;
  }

  return (
    <div className="h-full min-w-0 flex-1 flex flex-col bg-background overflow-hidden relative">
      <div className="flex-1 relative overflow-hidden">
        <div
          ref={scrollRef}
          className={cn(
            "absolute inset-0 overflow-y-auto thin-scrollbar",
            compact ? "p-2" : "p-3",
          )}
          tabIndex={0}
          onClick={(e) => {
            if (e.target === e.currentTarget) props.onBackgroundClick();
          }}
          onContextMenu={(e) =>
            props.drivesMode ? e.preventDefault() : props.onRowContextMenu(e)
          }
        >
          {body}
        </div>
      </div>

      <ColumnVisibilityMenu
        x={columnMenu.x}
        y={columnMenu.y}
        isVisible={columnMenu.visible}
        columns={columns}
        onClose={() => setColumnMenu((m) => ({ ...m, visible: false }))}
      />
    </div>
  );
}

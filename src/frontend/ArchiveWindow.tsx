import React from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  File,
  Folder,
  FolderUp,
  Info,
  Link2,
  PackageOpen,
} from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { formatFileSize } from "./vendor/file-manager/file-manager-utils";
import {
  isLocalFilesDrag,
  isRemoteFilesDrag,
} from "./vendor/file-manager/local-transfer-utils";
import { dragWithOverlay } from "./popup/dragOverlay";
import { listArchiveEntries, type WireEntry } from "./containerFsApi";
import {
  ARCHIVE_ENTRIES_MIME,
  clearArchiveDrag,
  setArchiveDrag,
} from "./workspace/archiveDragRegistry";
import {
  extensionOf,
  innerCrumbs,
  isDirEntry,
  sortEntries,
  summarize,
  type SortDir,
  type SortKey,
} from "./archiveView";

type MetaColumn = "size" | "modified" | "type";
const DEFAULT_WIDTHS: Record<MetaColumn, number> = {
  size: 88,
  modified: 160,
  type: 96,
};
const MIN_COLUMN = 48;
const MAX_COLUMN = 480;

function innerJoin(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function parentInner(dir: string): string {
  const i = dir.lastIndexOf("/");
  return i <= 0 ? "/" : dir.slice(0, i);
}

const TOOLBAR_BUTTON =
  "flex shrink-0 items-center gap-1.5 border border-border px-2 py-1 text-xs hover:bg-muted/40 disabled:opacity-40";

/**
 * A floating window showing the contents of an archive, laid out like a file
 * archiver: toolbar, address bar, sortable table and a status bar. Entries can
 * be dragged onto a file pane or extracted with the toolbar.
 */
export function ArchiveWindow({
  containerKey,
  containerId,
  archive,
  archiveName,
  onExtractSelected,
  onExtractAll,
}: {
  containerKey: string;
  containerId: string;
  archive: string;
  archiveName: string;
  /** Opens the destination picker for these archive-inner paths. */
  onExtractSelected: (entries: string[]) => void;
  /** Opens the destination picker for the whole archive. */
  onExtractAll: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [dir, setDir] = React.useState("/");
  const [entries, setEntries] = React.useState<WireEntry[]>([]);
  const [truncated, setTruncated] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [sort, setSort] = React.useState<{ key: SortKey; dir: SortDir }>({
    key: "name",
    dir: "asc",
  });
  const [showInfo, setShowInfo] = React.useState(false);
  const [dropOver, setDropOver] = React.useState(false);
  const anchor = React.useRef<string | null>(null);
  // Column widths live in this window's state only (gone with the window).
  const [widths, setWidths] = React.useState(DEFAULT_WIDTHS);
  const columnsStyle = React.useMemo<React.CSSProperties>(
    () => ({
      gridTemplateColumns: `minmax(0,1fr) ${widths.size}px ${widths.modified}px ${widths.type}px`,
    }),
    [widths],
  );
  const startResize = (key: MetaColumn, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = widths[key];
    dragWithOverlay("ew-resize", (x) => {
      // The handle is on the column's left edge: dragging left widens it.
      const next = Math.min(
        MAX_COLUMN,
        Math.max(MIN_COLUMN, start - (x - startX)),
      );
      setWidths((w) => (w[key] === next ? w : { ...w, [key]: next }));
    });
  };

  // Closing the window mid-drag must not leave the drag registered.
  React.useEffect(() => () => clearArchiveDrag(), []);

  React.useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setSelected(new Set());
    anchor.current = null;
    listArchiveEntries(containerKey, archive, dir, controller.signal)
      .then((data) => {
        setEntries(data.entries);
        setTruncated(data.truncated);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => controller.abort();
  }, [containerKey, archive, dir]);

  const sorted = React.useMemo(
    () => sortEntries(entries, sort.key, sort.dir),
    [entries, sort],
  );
  const names = sorted.map((e) => e.name);
  const crumbs = innerCrumbs(dir);
  const summary = summarize(entries, selected);

  const select = (e: React.MouseEvent, name: string) => {
    setSelected((prev) => {
      if (e.shiftKey && anchor.current) {
        const a = names.indexOf(anchor.current);
        const b = names.indexOf(name);
        if (a >= 0 && b >= 0) {
          return new Set(names.slice(Math.min(a, b), Math.max(a, b) + 1));
        }
      }
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        anchor.current = name;
        return next;
      }
      anchor.current = name;
      return new Set([name]);
    });
  };

  const dragPaths = (name: string): string[] =>
    (selected.has(name) ? [...selected] : [name]).map((n) => innerJoin(dir, n));

  const extractSelected = () => {
    if (selected.size > 0) {
      onExtractSelected([...selected].map((n) => innerJoin(dir, n)));
    }
  };

  const sortBy = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );

  const openEntry = (name: string) => {
    const entry = entries.find((e) => e.name === name);
    if (entry && isDirEntry(entry)) setDir(innerJoin(dir, name));
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === "Backspace") {
      ev.preventDefault();
      if (dir !== "/") setDir(parentInner(dir));
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (selected.size === 1) openEntry([...selected][0]);
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a") {
      ev.preventDefault();
      setSelected(new Set(names));
    } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (names.length === 0) return;
      const current = anchor.current ? names.indexOf(anchor.current) : -1;
      const next = Math.min(
        names.length - 1,
        Math.max(0, current + (ev.key === "ArrowDown" ? 1 : -1)),
      );
      anchor.current = names[next];
      setSelected(new Set([names[next]]));
    } else if (ev.key === "Escape") {
      setSelected(new Set());
    }
  };

  // Adding files to an archive is not supported: say so instead of letting a
  // file drag look like a download (or become one).
  const foreignFiles = (dt: DataTransfer | null) =>
    !!dt &&
    !dt.types.includes(ARCHIVE_ENTRIES_MIME) &&
    (isRemoteFilesDrag(dt) ||
      isLocalFilesDrag(dt) ||
      Array.from(dt.types).includes("Files"));

  const typeLabel = (e: WireEntry): string => {
    if (isDirEntry(e)) return t("containerFiles.archiveTypeFolder");
    if (e.type === "link" || e.type === "symlink")
      return t("containerFiles.archiveTypeLink");
    const ext = extensionOf(e.name);
    return ext
      ? t("containerFiles.archiveTypeFileExt", { ext: ext.toUpperCase() })
      : t("containerFiles.archiveTypeFile");
  };

  const header = (key: SortKey, label: string, right = false) => (
    <div className="relative flex min-w-0">
      {key !== "name" && (
        <div
          role="separator"
          aria-orientation="vertical"
          className="group/handle absolute bottom-0 left-0 top-0 z-10 w-2 cursor-ew-resize select-none"
          onMouseDown={(e) => startResize(key, e)}
          onDoubleClick={() =>
            setWidths((w) => ({ ...w, [key]: DEFAULT_WIDTHS[key] }))
          }
          onClick={(e) => e.stopPropagation()}
        >
          <div className="pointer-events-none absolute bottom-0.5 left-0 top-0.5 w-px bg-transparent group-hover/handle:bg-accent-brand/60" />
        </div>
      )}
      <button
        type="button"
        className={`flex min-w-0 flex-1 items-center gap-1 hover:text-foreground ${
          right ? "justify-end" : ""
        }`}
        onClick={() => sortBy(key)}
      >
        <span className="truncate">{label}</span>
        {sort.key === key &&
          (sort.dir === "asc" ? (
            <ArrowUp className="size-3 shrink-0" />
          ) : (
            <ArrowDown className="size-3 shrink-0" />
          ))}
      </button>
    </div>
  );

  const sizeText = (n: number) => formatFileSize(n);

  return (
    <div
      className="relative flex h-full flex-col bg-background text-xs outline-none"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onDragEnter={(e) => {
        if (!foreignFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        setDropOver(true);
      }}
      onDragOver={(e) => {
        if (!foreignFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "none";
        setDropOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setDropOver(false);
      }}
      onDrop={(e) => {
        setDropOver(false);
        if (!foreignFiles(e.dataTransfer)) return;
        // Never a download and never an upload: nothing happens.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <button
          type="button"
          className={TOOLBAR_BUTTON}
          title={t("containerFiles.archiveUp")}
          disabled={dir === "/"}
          onClick={() => setDir(parentInner(dir))}
        >
          <FolderUp className="size-3.5" />
          {t("containerFiles.archiveUp")}
        </button>
        <div className="mx-1 h-5 w-px bg-border" />
        <button
          type="button"
          className={TOOLBAR_BUTTON}
          disabled={selected.size === 0}
          title={t("containerFiles.archiveExtractSelectedHint")}
          onClick={extractSelected}
        >
          {t("containerFiles.archiveExtractSelected")}
        </button>
        <button type="button" className={TOOLBAR_BUTTON} onClick={onExtractAll}>
          {t("containerFiles.archiveExtractAll")}
        </button>
        <div className="flex-1" />
        <button
          type="button"
          className={`${TOOLBAR_BUTTON} ${showInfo ? "bg-muted/60" : ""}`}
          aria-pressed={showInfo}
          onClick={() => setShowInfo((v) => !v)}
        >
          <Info className="size-3.5" />
          {t("containerFiles.archiveInfo")}
        </button>
      </div>

      <nav
        className="flex items-center gap-0.5 border-b border-border bg-muted/20 px-2 py-1"
        aria-label={archiveName}
      >
        <button
          type="button"
          className="flex min-w-0 shrink items-center gap-1 px-1 py-0.5 hover:bg-muted/40"
          title={archive}
          onClick={() => setDir("/")}
        >
          <PackageOpen className="size-3.5 shrink-0" />
          <span className="max-w-[16rem] truncate">{archiveName}</span>
        </button>
        {crumbs.map((c) => (
          <React.Fragment key={c.path}>
            <ChevronRight className="size-3 shrink-0 opacity-60" />
            <button
              type="button"
              className="min-w-0 truncate px-1 py-0.5 hover:bg-muted/40"
              title={c.path}
              onClick={() => setDir(c.path)}
            >
              {c.name}
            </button>
          </React.Fragment>
        ))}
      </nav>

      {showInfo && (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-b border-border bg-muted/10 px-3 py-2">
          <dt className="text-muted-foreground">
            {t("containerFiles.archiveInfoName")}
          </dt>
          <dd className="truncate" title={archiveName}>
            {archiveName}
          </dd>
          <dt className="text-muted-foreground">
            {t("containerFiles.archiveInfoPath")}
          </dt>
          <dd className="truncate" title={archive}>
            {archive}
          </dd>
          <dt className="text-muted-foreground">
            {t("containerFiles.archiveInfoFolder")}
          </dt>
          <dd className="truncate">{dir}</dd>
          <dt className="text-muted-foreground">
            {t("containerFiles.archiveInfoContents")}
          </dt>
          <dd>
            {t("containerFiles.archiveInfoSummary", {
              count: summary.items,
              size: sizeText(summary.totalSize),
            })}
          </dd>
        </dl>
      )}

      <div
        className="grid gap-2 border-b border-border bg-muted/40 px-3 py-1 font-medium text-muted-foreground"
        style={columnsStyle}
      >
        {header("name", t("containerFiles.archiveColName"))}
        {header("size", t("containerFiles.archiveColSize"), true)}
        {header("modified", t("containerFiles.archiveColModified"))}
        {header("type", t("containerFiles.archiveColType"))}
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onClick={(ev) => {
          if (ev.target === ev.currentTarget) setSelected(new Set());
        }}
      >
        {error ? (
          <p className="p-3 text-destructive">{error}</p>
        ) : loading ? (
          <p className="p-3 text-muted-foreground">
            {t("containerFiles.archiveLoading")}
          </p>
        ) : entries.length === 0 ? (
          <p className="p-3 text-muted-foreground">
            {t("containerFiles.archiveEmpty")}
          </p>
        ) : (
          sorted.map((e) => (
            <div
              key={e.name}
              draggable
              className={`grid cursor-default select-none gap-2 px-3 py-1 ${
                selected.has(e.name) ? "bg-accent" : "hover:bg-accent/50"
              }`}
              style={columnsStyle}
              onClick={(ev) => select(ev, e.name)}
              onDoubleClick={() => openEntry(e.name)}
              onDragStart={(ev) => {
                const paths = dragPaths(e.name);
                if (!selected.has(e.name)) setSelected(new Set([e.name]));
                ev.dataTransfer.effectAllowed = "copy";
                ev.dataTransfer.setData(
                  ARCHIVE_ENTRIES_MIME,
                  JSON.stringify({ archive, entries: paths }),
                );
                ev.dataTransfer.setData(
                  "text/plain",
                  t("containerFiles.archiveEntriesTitle", {
                    count: paths.length,
                  }),
                );
                setArchiveDrag({ containerId, archive, entries: paths });
              }}
              onDragEnd={() => clearArchiveDrag()}
            >
              <span className="flex min-w-0 items-center gap-2" title={e.name}>
                {isDirEntry(e) ? (
                  <Folder className="size-4 shrink-0 text-accent-brand" />
                ) : e.type === "link" || e.type === "symlink" ? (
                  <Link2 className="size-4 shrink-0" />
                ) : (
                  <File className="size-4 shrink-0" />
                )}
                <span className="truncate">{e.name}</span>
              </span>
              <span className="text-right text-muted-foreground">
                {isDirEntry(e) ? "" : sizeText(e.size)}
              </span>
              <span className="truncate text-muted-foreground">
                {e.mtime ? new Date(e.mtime * 1000).toLocaleString() : ""}
              </span>
              <span className="truncate text-muted-foreground">
                {typeLabel(e)}
              </span>
            </div>
          ))
        )}
        {truncated && (
          <p className="p-3 text-muted-foreground">
            {t("containerFiles.archiveTruncated")}
          </p>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-border bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {t("containerFiles.archiveStatus", {
            count: summary.items,
            selected: summary.selected,
            size: sizeText(
              summary.selected > 0 ? summary.selectedSize : summary.totalSize,
            ),
          })}
        </span>
      </div>

      {dropOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex cursor-not-allowed items-center justify-center bg-background/70">
          <p className="border border-border bg-card px-4 py-3 text-xs font-bold uppercase tracking-widest text-muted-foreground">
            {t("containerFiles.archiveAddUnsupported")}
          </p>
        </div>
      )}
    </div>
  );
}

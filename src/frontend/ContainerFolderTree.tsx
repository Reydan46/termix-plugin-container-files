import React from "react";
import { ChevronRight, Folder, FolderOpen, Link2, Loader2 } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { TREE_MAX, TREE_MIN } from "./useFolderTree";
import { TREE_NODE_CAP, type TreeNodes } from "./folderTree";
import type { MountMark } from "./mountLookup";
import { MOUNT_ICON_CLASS, MountLetters } from "./MountLetters";

interface Props {
  nodes: TreeNodes;
  expanded: Set<string>;
  currentPath: string;
  width: number;
  onWidth: (width: number, persist?: boolean) => void;
  onToggle: (path: string) => void;
  onLoad: (path: string) => void;
  onNavigate: (path: string) => void;
  /** Paths dragged from the grid onto a folder node. */
  onDropPaths: (paths: string[], dest: string) => void;
  parsePaths: (raw: string) => string[];
  /** Top-level nodes; default: the single root "/". */
  roots?: ReadonlyArray<{ path: string; label: string }>;
  /** Shown above the tree (quick access); stays put while the tree scrolls. */
  header?: React.ReactNode;
  /** Drop effect offered over a folder; default "move". */
  dropEffect?: "move" | "copy";
  /** Badge for a folder that is a mount point. */
  mountMark?: (path: string) => MountMark | null;
}

const DEFAULT_ROOTS = [{ path: "/", label: "/" }] as const;

export function ContainerFolderTree(props: Props): React.ReactElement {
  const { t } = useTranslation();
  const { width, onWidth } = props;
  const [dropTarget, setDropTarget] = React.useState<string | null>(null);

  // Ends a resize in progress; also runs on unmount so no listener leaks.
  const stopResize = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => stopResize.current?.(), []);

  const startResize = (event: React.PointerEvent) => {
    stopResize.current?.();
    event.preventDefault();
    const startX = event.clientX;
    const startW = width;
    let last = startW;
    const move = (e: PointerEvent) => {
      last = Math.max(
        TREE_MIN,
        Math.min(TREE_MAX, startW + e.clientX - startX),
      );
      onWidth(last, false);
    };
    const detach = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      stopResize.current = null;
    };
    const up = () => {
      detach();
      onWidth(last, true);
    };
    stopResize.current = detach;
    window.addEventListener("pointercancel", up);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const row = (
    path: string,
    name: string,
    link: boolean,
    depth: number,
  ): React.ReactNode => {
    const node = props.nodes[path];
    const open = props.expanded.has(path);
    const current = path === props.currentPath;
    return (
      <React.Fragment key={path}>
        <div
          role="treeitem"
          aria-expanded={open}
          aria-selected={current}
          data-tree-path={path}
          className={`flex cursor-pointer items-center gap-1 py-0.5 pr-2 text-xs hover:bg-muted/40 ${
            current
              ? "bg-accent-brand/15 text-foreground"
              : "text-muted-foreground"
          } ${dropTarget === path ? "outline outline-1 outline-accent-brand" : ""}`}
          style={{ paddingLeft: 4 + depth * 12 }}
          title={path}
          onClick={() => props.onNavigate(path)}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = props.dropEffect ?? "move";
            if (dropTarget !== path) setDropTarget(path);
          }}
          onDragLeave={() => setDropTarget((d) => (d === path ? null : d))}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(null);
            const paths = props.parsePaths(
              e.dataTransfer.getData("text/plain"),
            );
            if (paths.length > 0) props.onDropPaths(paths, path);
          }}
        >
          <button
            type="button"
            className="flex size-4 shrink-0 items-center justify-center"
            aria-label={t("containerFiles.treeToggle")}
            onClick={(e) => {
              e.stopPropagation();
              props.onToggle(path);
            }}
          >
            {node?.status === "loading" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ChevronRight
                className={`size-3 transition-transform ${open ? "rotate-90" : ""}`}
              />
            )}
          </button>
          {(() => {
            const mark = props.mountMark?.(path);
            const Icon = open ? FolderOpen : Folder;
            return (
              <>
                <span
                  title={mark?.title}
                  className={`relative inline-flex size-3.5 shrink-0 ${mark ? MOUNT_ICON_CLASS : ""}`}
                >
                  <Icon className="size-3.5" />
                  {mark && <MountLetters label={mark.label} />}
                </span>
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {link && <Link2 className="size-3 shrink-0 opacity-60" />}
              </>
            );
          })()}
        </div>
        {open && node && (
          <>
            {node.status === "error" && (
              <div
                className="flex items-center gap-1 text-[11px] text-destructive"
                style={{ paddingLeft: 24 + depth * 12 }}
                title={node.error}
              >
                <span className="truncate">
                  {t("containerFiles.treeError")}
                </span>
                <button
                  type="button"
                  className="underline"
                  onClick={() => props.onLoad(path)}
                >
                  {t("containers.refresh")}
                </button>
              </div>
            )}
            {node.dirs.map((d) => row(d.path, d.name, d.link, depth + 1))}
            {node.more && (
              <div
                className="text-[11px] italic text-muted-foreground"
                style={{ paddingLeft: 24 + depth * 12 }}
              >
                {t("containerFiles.treeMore", { count: TREE_NODE_CAP })}
              </div>
            )}
          </>
        )}
      </React.Fragment>
    );
  };

  return (
    <div className="relative flex shrink-0" style={{ width }}>
      <div className="flex min-w-0 flex-1 flex-col border-r border-border">
        {props.header}
        <div role="tree" className="min-h-0 flex-1 overflow-auto py-1">
          {(props.roots ?? DEFAULT_ROOTS).map((r) =>
            row(r.path, r.label, false, 0),
          )}
        </div>
      </div>
      <div
        className="absolute inset-y-0 -right-1 z-10 w-2 cursor-ew-resize"
        onPointerDown={startResize}
      />
    </div>
  );
}

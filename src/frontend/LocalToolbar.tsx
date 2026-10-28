import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  History,
  Home,
  Image as ImageIcon,
  Laptop,
  Layout,
  Monitor,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  PanelSearch,
  ViewToggle,
} from "@termix-ssh/plugin-sdk/ui";
import type { LocalDensity, LocalViewMode } from "./localViewPrefs";
import { isActivePane, paneOf } from "./paneFocus";
import type { LocalSortField } from "./vendor/file-manager/local-transfer-utils";
import {
  THIS_PC,
  breadcrumbParts,
  driveLetterOf,
  pathKey,
  rootOf,
  type LocalShortcut,
  type ShortcutId,
} from "./localPathUtils";

export const SHORTCUT_ICONS: Record<ShortcutId, typeof Home> = {
  home: Home,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  pictures: ImageIcon,
};

/** Short name of a root for buttons and menus: "C:", "\\srv\share" or "/". */
export function rootLabel(root: string): string {
  const letter = driveLetterOf(root);
  if (letter) return `${letter}:`;
  return root === "/" ? "/" : root.replace(/\\$/, "");
}

export interface PlacesState {
  windows: boolean;
  /** Probed drive roots; null until the first probe finished. */
  drives: string[] | null;
  shortcuts: LocalShortcut[];
  recents: string[];
  /** Called when the places menu opens, to (re)probe the drives. */
  onOpen: () => void;
}

interface Props {
  currentPath: string;
  places: PlacesState;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onRefresh: () => void;
  /** Crumb, drive or shortcut: a location that is already a path. */
  onNavigate: (path: string) => void;
  /** Text typed in the path bar. */
  onNavigateTyped: (text: string) => void;
  selectedCount: number;
  onDeleteSelected: () => void;
  onCopySelected: () => void;
  onUploadSelected?: () => void;
  search: string;
  onSearch: (value: string) => void;
  sortBy: LocalSortField;
  sortOrder: "asc" | "desc";
  onSortBy: (field: LocalSortField) => void;
  onSortOrder: (order: "asc" | "desc") => void;
  canCreate: boolean;
  onNewFolder: () => void;
  onNewFile: () => void;
  showHidden: boolean;
  onToggleHidden: () => void;
  onReveal: () => void;
  viewMode: LocalViewMode;
  onViewMode: (mode: LocalViewMode) => void;
  density: LocalDensity;
  onDensity: (density: LocalDensity) => void;
  onClose?: () => void;
}

function Breadcrumb({
  currentPath,
  onNavigate,
}: Pick<Props, "currentPath" | "onNavigate">) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Long paths keep the current folder in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [currentPath]);
  const crumbs = breadcrumbParts(currentPath);
  return (
    <>
      {currentPath === THIS_PC ? (
        <Laptop className="size-3.5 text-accent-brand shrink-0" />
      ) : (
        <Folder className="size-3.5 text-accent-brand shrink-0" />
      )}
      <div
        ref={scrollRef}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none text-xs whitespace-nowrap"
      >
        {currentPath === THIS_PC && <span>{t("localFiles.thisPc")}</span>}
        {crumbs.map((crumb, i) => (
          <React.Fragment key={crumb.path}>
            {i > 0 && (
              <ChevronRight className="size-3 text-muted-foreground shrink-0" />
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onNavigate(crumb.path);
              }}
              className="hover:text-accent-brand transition-colors"
            >
              {crumb.label}
            </button>
          </React.Fragment>
        ))}
      </div>
    </>
  );
}

/** Breadcrumb that turns into a text field on click; Enter goes, Esc cancels. */
function PathBar({
  currentPath,
  onNavigate,
  onNavigateTyped,
  className: baseClass,
}: Pick<Props, "currentPath" | "onNavigate" | "onNavigateTyped"> & {
  className: string;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);
  const className = baseClass;

  useEffect(() => {
    if (!editing) return;
    doneRef.current = false;
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(timer);
  }, [editing]);

  const commit = (text: string) => {
    if (doneRef.current) return;
    doneRef.current = true;
    setEditing(false);
    const trimmed = text.trim();
    if (trimmed && trimmed !== currentPath) onNavigateTyped(trimmed);
  };
  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setEditing(false);
  };

  if (editing) {
    return (
      <div className={className}>
        <Folder className="size-3.5 text-accent-brand shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={() => commit(value)}
          className="flex-1 min-w-0 bg-transparent text-xs font-semibold tracking-wide outline-none text-foreground"
        />
      </div>
    );
  }
  return (
    <div
      className={`${className} cursor-text`}
      title={t("localFiles.pathHint")}
      onClick={() => {
        setValue(currentPath === THIS_PC ? "" : currentPath);
        setEditing(true);
      }}
    >
      <Breadcrumb currentPath={currentPath} onNavigate={onNavigate} />
    </div>
  );
}

/** Drives, quick access and recent locations in one menu. */
function PlacesMenu({
  currentPath,
  places,
  onNavigate,
}: Pick<Props, "currentPath" | "places" | "onNavigate">) {
  const { t } = useTranslation();
  const root = currentPath === THIS_PC ? null : rootOf(currentPath);
  const rootKey = root ? pathKey(root) : null;
  const here = (path: string) => rootKey !== null && pathKey(path) === rootKey;
  const go = (path: string) => setTimeout(() => onNavigate(path), 0);
  const triggerLabel =
    currentPath === THIS_PC
      ? t("localFiles.thisPc")
      : root
        ? rootLabel(root)
        : "";
  const recents = places.recents.filter(
    (r) => !(places.drives ?? []).some((d) => pathKey(d) === pathKey(r)),
  );
  return (
    <DropdownMenu onOpenChange={(open) => open && places.onOpen()}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="w-auto gap-1 px-2"
          title={t("localFiles.places")}
          aria-label={t("localFiles.places")}
        >
          <HardDrive className="size-4" />
          {triggerLabel && (
            <span className="max-w-24 truncate text-[10px] tabular-nums">
              {triggerLabel}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-56 bg-card"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground">
          {places.windows
            ? t("localFiles.drives")
            : t("localFiles.filesystemRoot")}
        </DropdownMenuLabel>
        {places.windows && (
          <DropdownMenuItem
            onSelect={() => go(THIS_PC)}
            className="gap-2 focus:bg-accent-brand/10 focus:text-accent-brand"
          >
            <Laptop className="size-4 text-accent-brand" />
            <span className="flex-1 truncate">{t("localFiles.thisPc")}</span>
            {currentPath === THIS_PC && <Check className="size-3.5" />}
          </DropdownMenuItem>
        )}
        {!places.windows && (
          <DropdownMenuItem
            onSelect={() => go("/")}
            className="gap-2 focus:bg-accent-brand/10 focus:text-accent-brand"
          >
            <HardDrive className="size-4 text-accent-brand" />
            <span className="flex-1">/</span>
            {here("/") && <Check className="size-3.5" />}
          </DropdownMenuItem>
        )}
        {places.windows && places.drives === null && (
          <DropdownMenuItem disabled className="text-xs text-muted-foreground">
            {t("localFiles.searching")}
          </DropdownMenuItem>
        )}
        {places.windows &&
          places.drives?.map((drive) => (
            <DropdownMenuItem
              key={drive}
              onSelect={() => go(drive)}
              className="gap-2 focus:bg-accent-brand/10 focus:text-accent-brand"
            >
              <HardDrive className="size-4 text-accent-brand" />
              <span className="flex-1 truncate">{rootLabel(drive)}</span>
              {here(drive) && <Check className="size-3.5" />}
            </DropdownMenuItem>
          ))}
        {places.windows && places.drives?.length === 0 && (
          <DropdownMenuItem disabled className="text-xs text-muted-foreground">
            {t("localFiles.drivesEmpty")}
          </DropdownMenuItem>
        )}
        {places.windows && places.drives !== null && (
          <p className="px-2 py-1 text-[10px] leading-snug text-muted-foreground">
            {t("localFiles.driveHint")}
          </p>
        )}
        {places.shortcuts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {t("localFiles.quickAccess")}
            </DropdownMenuLabel>
            {places.shortcuts.map((s) => {
              const Icon = SHORTCUT_ICONS[s.id];
              return (
                <DropdownMenuItem
                  key={s.id}
                  onSelect={() => go(s.path)}
                  className="gap-2 focus:bg-accent-brand/10 focus:text-accent-brand"
                >
                  <Icon className="size-4 text-accent-brand" />
                  <span className="flex-1 truncate">
                    {t(`localFiles.place.${s.id}`)}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </>
        )}
        {recents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {t("localFiles.recent")}
            </DropdownMenuLabel>
            {recents.map((r) => (
              <DropdownMenuItem
                key={r}
                onSelect={() => go(r)}
                className="gap-2 focus:bg-accent-brand/10 focus:text-accent-brand"
              >
                <History className="size-4 text-muted-foreground" />
                <span className="flex-1 truncate" title={r}>
                  {r}
                </span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Toolbar of the local pane; same look as the container's. */
export function LocalToolbar(props: Props): React.ReactElement {
  const { t } = useTranslation();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Ctrl+F focuses the filter of the pane that owns the keys.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "f"
      )
        return;
      const input = searchInputRef.current;
      if (!input) return;
      const visible =
        typeof input.checkVisibility === "function"
          ? input.checkVisibility({ visibilityProperty: true })
          : input.offsetParent !== null;
      if (!visible) return;
      const active = document.activeElement;
      if (
        active !== input &&
        active?.closest(
          'input, textarea, [contenteditable="true"], [role="dialog"]',
        )
      )
        return;
      // Only the pane the user is working in answers.
      if (!isActivePane(paneOf(rootRef.current))) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const hiddenTitle = props.showHidden
    ? t("fileManager.localHideHidden")
    : t("fileManager.localShowHidden");
  const pathBarProps = {
    currentPath: props.currentPath,
    onNavigate: props.onNavigate,
    onNavigateTyped: props.onNavigateTyped,
  };

  return (
    <div
      ref={rootRef}
      className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2"
    >
      <div className="flex w-full flex-row items-center gap-2">
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onToggleSidebar}
            className={
              props.sidebarOpen
                ? ""
                : "md:bg-accent-brand/10 md:text-accent-brand"
            }
            title={t("fileManager.toggleSidebar")}
            aria-pressed={!props.sidebarOpen}
          >
            <Layout className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onBack}
            disabled={!props.canBack}
            title={t("fileManager.back")}
            aria-label={t("fileManager.back")}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onForward}
            disabled={!props.canForward}
            title={t("fileManager.forward")}
            aria-label={t("fileManager.forward")}
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onUp}
            disabled={!props.canUp}
            title={t("fileManager.up")}
            aria-label={t("fileManager.up")}
          >
            <ArrowUp className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onRefresh}
            title={t("fileManager.refresh")}
            aria-label={t("fileManager.refresh")}
          >
            <RefreshCw
              className={`size-4 ${props.loading ? "animate-spin [animation-duration:0.5s]" : ""}`}
            />
          </Button>
          <PlacesMenu
            currentPath={props.currentPath}
            places={props.places}
            onNavigate={props.onNavigate}
          />
        </div>

        <PathBar
          {...pathBarProps}
          className="hidden h-8 min-w-0 flex-1 items-center gap-2 overflow-hidden border border-border px-2.5 md:flex"
        />

        <div className="flex shrink-0 items-center gap-2">
          {props.selectedCount > 0 && (
            <div className="flex items-center gap-1 border border-accent-brand/30 bg-accent-brand/10 pl-2 pr-1">
              <span className="text-[10px] tabular-nums text-accent-brand">
                {props.selectedCount}
              </span>
              {props.onUploadSelected && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={t("localFiles.uploadSelected")}
                  className="text-accent-brand hover:bg-accent-brand/20"
                  onClick={props.onUploadSelected}
                >
                  <Upload className="size-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                title={t("fileManager.delete")}
                className="text-accent-brand hover:bg-accent-brand/20"
                onClick={props.onDeleteSelected}
              >
                <Trash2 className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                title={t("fileManager.copy")}
                className="text-accent-brand hover:bg-accent-brand/20"
                onClick={props.onCopySelected}
              >
                <Copy className="size-3.5" />
              </Button>
            </div>
          )}

          <PanelSearch
            inputRef={searchInputRef}
            value={props.search}
            onChange={props.onSearch}
            placeholder={t("fileManager.searchFiles")}
            className="w-28 md:w-44"
          />

          <ViewToggle
            view={props.viewMode}
            onView={props.onViewMode}
            density={props.density}
            onDensity={props.onDensity}
          />

          <Button
            variant="outline"
            onClick={props.onToggleHidden}
            title={hiddenTitle}
            aria-label={hiddenTitle}
          >
            {props.showHidden ? (
              <Eye className="size-3.5" />
            ) : (
              <EyeOff className="size-3.5" />
            )}
          </Button>

          <Button
            variant="outline"
            onClick={props.onReveal}
            disabled={!props.canCreate}
            className="hidden md:flex"
            title={t("fileManager.localRevealInFileManager")}
            aria-label={t("fileManager.localRevealInFileManager")}
          >
            <FolderOpen className="size-3.5" />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                title={t("fileManager.sortBy")}
                aria-label={t("fileManager.sortBy")}
              >
                <ArrowUpDown className="size-3.5" />
                <span className="hidden md:inline">
                  {t("fileManager.sortBy")}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-44 bg-card"
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              <DropdownMenuRadioGroup
                value={props.sortBy}
                onValueChange={(v) => props.onSortBy(v as LocalSortField)}
              >
                <DropdownMenuRadioItem value="name">
                  {t("fileManager.sortByName")}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="modified">
                  {t("fileManager.sortByDate")}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="size">
                  {t("fileManager.sortBySize")}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="kind">
                  {t("fileManager.kind")}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup
                value={props.sortOrder}
                onValueChange={(v) => props.onSortOrder(v as "asc" | "desc")}
              >
                <DropdownMenuRadioItem value="asc">
                  {t("fileManager.ascending")}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="desc">
                  {t("fileManager.descending")}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                disabled={!props.canCreate}
                title={t("fileManager.new")}
                aria-label={t("fileManager.new")}
                className="border-accent-brand/40 text-accent-brand hover:bg-accent-brand/10 hover:text-accent-brand dark:border-accent-brand/40"
              >
                <Plus className="size-3.5" />
                {t("fileManager.new")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-44 bg-card"
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              <DropdownMenuItem
                onSelect={() => setTimeout(() => props.onNewFolder(), 0)}
                className="gap-2 focus:bg-accent-brand/10 focus:text-accent-brand"
              >
                <FolderPlus className="size-4 text-accent-brand" />
                {t("fileManager.newFolder")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setTimeout(() => props.onNewFile(), 0)}
                className="gap-2 focus:bg-accent-brand/10 focus:text-accent-brand"
              >
                <FilePlus className="size-4 text-muted-foreground" />
                {t("fileManager.newFile")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {props.onClose && (
            <Button
              variant="ghost"
              size="icon"
              onClick={props.onClose}
              title={t("fileManager.hideLocalFiles")}
              aria-label={t("fileManager.hideLocalFiles")}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 md:hidden">
        <PathBar
          {...pathBarProps}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 overflow-hidden border border-border px-2.5"
        />
      </div>
    </div>
  );
}

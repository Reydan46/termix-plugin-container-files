import React from "react";
import { DIALOG_DEFAULT } from "./popup/useDialogKeys";
import { ArrowUp, File, Folder } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { usePopupWindow } from "./popup/PopupContext";
import { usePopups } from "./popup/usePopups";
import { useWindowManager } from "./vendor/file-manager/components/WindowManager";
import { POPUP_WIDTH } from "./popup/popupGeometry";
import {
  POPUP_ACTIONS,
  POPUP_BUTTON,
  POPUP_BUTTON_PRIMARY,
} from "./popup/popupStyles";
import { parentDir } from "./pathHelpers";
import { listFiles } from "./containerFsApi";

const MAX_ROWS = 500;

interface Entry {
  name: string;
  path: string;
  directory: boolean;
}

const rowClass = (active: boolean) =>
  `flex w-full items-center gap-2 border px-2 py-1 text-left text-xs ${
    active
      ? "border-accent-brand/60 bg-accent-brand/10"
      : "border-transparent hover:bg-muted/40"
  }`;

/**
 * A small floating window to browse the container's filesystem and pick a
 * folder (mode "folder") or a file or folder (mode "any"). Clicking a folder
 * enters it; with nothing selected the shown folder itself is picked.
 */
const PENDING_TIMEOUT_MS = 3000;

export function PathPickerWindow({
  containerKey,
  initialDir,
  mode,
  fileFilter,
  onPick,
}: {
  containerKey: string;
  initialDir: string;
  mode: "folder" | "any";
  fileFilter?: (name: string) => boolean;
  onPick: (path: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const { close } = usePopupWindow();
  const [dir, setDir] = React.useState(initialDir);
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(null);
    listFiles(containerKey, dir, { signal: controller.signal })
      .then((result) => {
        if (cancelled) return;
        setEntries(
          result.files
            .filter((f) =>
              f.type === "directory"
                ? true
                : mode === "any" && (!fileFilter || fileFilter(f.name)),
            )
            .map((f) => ({
              name: f.name,
              path: f.path,
              directory: f.type === "directory",
            }))
            .sort(
              (a, b) =>
                Number(b.directory) - Number(a.directory) ||
                a.name.localeCompare(b.name),
            ),
        );
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setEntries([]);
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [containerKey, dir, mode, fileFilter]);

  // With a filter only a listed file can be picked, never the folder itself.
  const chosen = selected ?? (fileFilter ? null : dir);

  return (
    <>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          className="border border-border p-1 hover:bg-muted/40 disabled:opacity-40"
          disabled={dir === "/"}
          aria-label={t("containerFiles.pickerUp")}
          title={t("containerFiles.pickerUp")}
          onClick={() => setDir(parentDir(dir))}
        >
          <ArrowUp className="size-3.5" />
        </button>
        <span className="truncate font-mono text-xs" title={dir}>
          {dir}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border border-border">
        {loading && (
          <p className="p-2 text-xs text-muted-foreground">
            {t("containerFiles.pickerLoading")}
          </p>
        )}
        {error && <p className="p-2 text-xs text-destructive">{error}</p>}
        {!loading && !error && entries.length === 0 && (
          <p className="p-2 text-xs text-muted-foreground">
            {t("containerFiles.pickerEmpty")}
          </p>
        )}
        {entries.slice(0, MAX_ROWS).map((e) =>
          e.directory ? (
            <button
              key={e.path}
              type="button"
              className={rowClass(false)}
              onClick={() => setDir(e.path)}
            >
              <Folder className="size-3.5 shrink-0 text-accent-brand" />
              <span className="truncate font-mono">{e.name}</span>
            </button>
          ) : (
            <button
              key={e.path}
              type="button"
              className={rowClass(selected === e.path)}
              onClick={() => setSelected(e.path)}
            >
              <File className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono">{e.name}</span>
            </button>
          ),
        )}
      </div>
      <div className={POPUP_ACTIONS}>
        <button type="button" className={POPUP_BUTTON} onClick={close}>
          {t("containerFiles.pickerCancel")}
        </button>
        <button
          type="button"
          {...DIALOG_DEFAULT}
          className={`${POPUP_BUTTON_PRIMARY} disabled:opacity-40`}
          disabled={chosen === null}
          onClick={() => {
            if (chosen === null) return;
            close();
            onPick(chosen);
          }}
        >
          {t("containerFiles.pickerSelect")}
        </button>
      </div>
    </>
  );
}

interface PickOptions {
  title: string;
  initialDir: string;
  mode: "folder" | "any";
  /** Shows only files whose name passes, and requires one to be selected. */
  fileFilter?: (name: string) => boolean;
  onPick: (path: string) => void;
}

/**
 * Returns a function that opens the picker as a popup. Called from inside
 * another popup it opens over it (raised above it) and closes together with
 * it. Each opener (told apart by `title`) has at most one picker: pressing
 * its button again raises the open one instead of opening another.
 */
export function usePathPicker(
  containerKey: string,
): (opts: PickOptions) => void {
  const openPopup = usePopups();
  const { windows, focusWindow } = useWindowManager();
  const live = React.useRef(windows);
  live.current = windows;
  const open = React.useRef(new Map<string, string>());
  // Opened but not yet rendered as a window (a quick second click).
  const pending = React.useRef(new Set<string>());
  React.useEffect(() => {
    const set = pending.current;
    return () => set.clear();
  }, []);
  for (const id of [...pending.current])
    if (windows.some((w) => w.id === id)) pending.current.delete(id);
  return (opts) => {
    const existing = open.current.get(opts.title);
    if (
      existing &&
      (pending.current.has(existing) ||
        live.current.some((w) => w.id === existing))
    ) {
      focusWindow(existing);
      return;
    }
    const id = openPopup({
      title: opts.title,
      width: POPUP_WIDTH.normal,
      height: 440,
      minWidth: 360,
      minHeight: 300,
      fit: false,
      render: () => (
        <PathPickerWindow
          containerKey={containerKey}
          initialDir={opts.initialDir}
          mode={opts.mode}
          fileFilter={opts.fileFilter}
          onPick={opts.onPick}
        />
      ),
    });
    open.current.set(opts.title, id);
    pending.current.add(id);
    // A window that never rendered (opener gone, render failed) must not
    // block reopening forever.
    setTimeout(() => pending.current.delete(id), PENDING_TIMEOUT_MS);
  };
}

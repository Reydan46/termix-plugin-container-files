import React from "react";
import { ArrowUp, File, Folder } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Input } from "@termix-ssh/plugin-sdk/ui";
import { DraggableWindow } from "./vendor/file-manager/components/DraggableWindow";
import { useWindowManager } from "./vendor/file-manager/components/WindowManager";
import { popupTitle } from "./popup/popupTitle";
import { PopupHeader } from "./popup/PopupHeader";
import { usePopupWindow } from "./popup/PopupContext";
import {
  POPUP_ACTIONS,
  POPUP_BUTTON,
  POPUP_BUTTON_PRIMARY,
} from "./popup/popupStyles";
import { ContainerConsole } from "./ContainerConsole";
import type { Origin } from "./sessionOrigin";
import { listFiles } from "./containerFsApi";
import {
  TERMINAL_SHELLS,
  isShellPath,
  isTerminalShell,
} from "./terminalCommand";

const SHELL_KEY = "container-files.terminalShell";
const MAX_ROWS = 500;

/** The shell that last worked in this container, if remembered. */
export function readRememberedShell(containerId: string): string | null {
  try {
    const saved = localStorage.getItem(`${SHELL_KEY}.${containerId}`);
    return saved && isTerminalShell(saved) ? saved : null;
  } catch {
    return null; // storage may be blocked
  }
}

export function rememberShell(containerId: string, shell: string | null): void {
  try {
    const key = `${SHELL_KEY}.${containerId}`;
    if (shell) localStorage.setItem(key, shell);
    else localStorage.removeItem(key);
  } catch {
    // remembering the choice is optional
  }
}

/** A floating window with only the container's shell. */
export function TerminalWindow({
  windowId,
  title,
  container,
  sessionId,
  containerId,
  dir,
  shell,
  origin,
  onStarted,
  onFailed,
}: {
  windowId: string;
  /** What the window is, e.g. "Terminal". */
  title: string;
  /** Container name shown after the title. */
  container?: string;
  sessionId: string;
  containerId: string;
  dir: string;
  shell: string;
  origin: Origin;
  onStarted?: () => void;
  /** The shell did not start; the caller offers another one. */
  onFailed?: (message?: string) => void;
}): React.ReactElement | null {
  const { closeWindow, minimizeWindow, maximizeWindow, focusWindow, windows } =
    useWindowManager();
  const current = windows.find((w) => w.id === windowId);
  const [started, setStarted] = React.useState<string | null>(null);
  if (!current) return null;
  return (
    <DraggableWindow
      title={popupTitle({
        what: title,
        container,
        extra: (started ?? (shell === "auto" ? "" : shell)).split("/").pop(),
      })}
      label=""
      titleContent={
        <PopupHeader
          what={title}
          container={container}
          extra={(started ?? (shell === "auto" ? "" : shell)).split("/").pop()}
        />
      }
      initialX={current.x}
      initialY={current.y}
      initialWidth={current.width}
      initialHeight={current.height}
      minWidth={400}
      minHeight={250}
      onClose={() => closeWindow(windowId)}
      onMinimize={() => minimizeWindow(windowId)}
      onMaximize={() => maximizeWindow(windowId)}
      onFocus={() => focusWindow(windowId)}
      isMaximized={current.isMaximized}
      zIndex={current.zIndex}
    >
      <ContainerConsole
        sessionId={sessionId}
        containerId={containerId}
        dir={dir}
        shell={shell}
        origin={origin}
        isVisible={!current.isMinimized}
        onStarted={onStarted}
        onShell={setStarted}
        onEarlyFailure={(message) => {
          closeWindow(windowId);
          onFailed?.(message);
        }}
      />
    </DraggableWindow>
  );
}

const rowClass = (active: boolean) =>
  `flex w-full items-center gap-2 border px-2 py-1 text-left text-xs ${
    active
      ? "border-accent-brand/60 bg-accent-brand/10"
      : "border-transparent hover:bg-muted/40"
  }`;

function parentOf(path: string): string {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/**
 * Browses the container's filesystem to pick an executable, starting at /bin
 * (or /usr/bin). Uses the same listing API as the file manager.
 */
function ShellBrowser({
  containerKey,
  selected,
  onSelect,
}: {
  containerKey: string;
  selected: string | null;
  onSelect: (path: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [dir, setDir] = React.useState<string | null>(null);
  const [entries, setEntries] = React.useState<
    { name: string; path: string; directory: boolean; executable: boolean }[]
  >([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [filter, setFilter] = React.useState("");

  React.useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      // The first load tries /bin, then /usr/bin, then the root.
      const candidates = dir === null ? ["/bin", "/usr/bin", "/"] : [dir];
      for (const candidate of candidates) {
        try {
          const result = await listFiles(containerKey, candidate, {
            signal: controller.signal,
          });
          if (cancelled) return;
          setEntries(
            result.files
              .map((f) => ({
                name: f.name,
                path: f.path,
                directory: f.type === "directory",
                executable: !!f.executable,
              }))
              .sort(
                (a, b) =>
                  Number(b.directory) - Number(a.directory) ||
                  a.name.localeCompare(b.name),
              ),
          );
          if (dir === null) setDir(result.path || candidate);
          setLoading(false);
          return;
        } catch (e) {
          if (cancelled) return;
          if (candidate === candidates[candidates.length - 1]) {
            setError(e instanceof Error ? e.message : String(e));
            setEntries([]);
            setLoading(false);
            if (dir === null) setDir("/");
          }
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [containerKey, dir]);

  const go = (path: string) => {
    setFilter("");
    setDir(path);
  };
  const shown = entries
    .filter((e) => e.name.toLowerCase().includes(filter.trim().toLowerCase()))
    .slice(0, MAX_ROWS);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="border border-border p-1 hover:bg-muted/40 disabled:opacity-40"
          disabled={!dir || dir === "/"}
          aria-label={t("containerFiles.pickerUp")}
          title={t("containerFiles.pickerUp")}
          onClick={() => dir && go(parentOf(dir))}
        >
          <ArrowUp className="size-3.5" />
        </button>
        <span className="truncate font-mono text-xs" title={dir ?? ""}>
          {dir ?? "…"}
        </span>
      </div>
      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={t("containerFiles.pickerFilter")}
        autoComplete="off"
        spellCheck={false}
        className="h-7 rounded-none text-xs"
      />
      <div className="min-h-0 flex-1 overflow-y-auto border border-border">
        {loading && (
          <p className="p-2 text-xs text-muted-foreground">
            {t("containerFiles.pickerLoading")}
          </p>
        )}
        {error && <p className="p-2 text-xs text-destructive">{error}</p>}
        {!loading && !error && shown.length === 0 && (
          <p className="p-2 text-xs text-muted-foreground">
            {t("containerFiles.pickerEmpty")}
          </p>
        )}
        {shown.map((e) =>
          e.directory ? (
            <button
              key={e.path}
              type="button"
              className={rowClass(false)}
              onClick={() => go(e.path)}
            >
              <Folder className="size-3.5 shrink-0 text-accent-brand" />
              <span className="truncate font-mono">{e.name}</span>
            </button>
          ) : (
            <button
              key={e.path}
              type="button"
              disabled={!e.executable}
              className={`${rowClass(selected === e.path)} disabled:cursor-not-allowed disabled:opacity-40`}
              title={
                e.executable ? e.path : t("containerFiles.pickerNotExecutable")
              }
              onClick={() => onSelect(e.path)}
            >
              <File className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono">{e.name}</span>
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * A floating window, like the editor, that asks which shell to start. It is
 * opened only when the automatic choice failed to start.
 */
export function ShellPickerWindow({
  containerKey,
  shells,
  initial,
  notice,
  onOpen,
}: {
  containerKey: string;
  /** Absolute paths of shells found in the container. */
  shells: string[];
  initial?: string | null;
  notice?: string;
  onOpen: (shell: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const { windowId, close } = usePopupWindow();
  const [choice, setChoice] = React.useState<string>(
    initial && isTerminalShell(initial) ? initial : (shells[0] ?? "auto"),
  );
  const names = TERMINAL_SHELLS.filter(
    (n) => n !== "auto" && !shells.some((p) => p.endsWith(`/${n}`)),
  );
  const options: { value: string; label: string }[] = [
    { value: "auto", label: t("containerFiles.terminalShellAuto") },
    ...shells.map((p) => ({ value: p, label: p })),
    ...names.map((n) => ({ value: n, label: n })),
  ];
  if (!options.some((o) => o.value === choice) && isShellPath(choice))
    options.push({ value: choice, label: choice });
  const canOpen = isTerminalShell(choice);
  return (
    <>
      {notice && <p className="text-xs text-destructive">{notice}</p>}
      <p className="text-xs text-muted-foreground">
        {t("containerFiles.terminalShellDesc")}
      </p>
      <div
        role="radiogroup"
        aria-label={t("containerFiles.terminalShell")}
        className="flex max-h-32 shrink-0 flex-col gap-0.5 overflow-y-auto"
      >
        {options.map((o) => (
          <label key={o.value} className={rowClass(choice === o.value)}>
            <input
              type="radio"
              name={`container-files-shell-${windowId}`}
              checked={choice === o.value}
              onChange={() => setChoice(o.value)}
            />
            <span className="font-mono">{o.label}</span>
          </label>
        ))}
      </div>
      <p className="text-xs font-medium">{t("containerFiles.pickerBrowse")}</p>
      <ShellBrowser
        containerKey={containerKey}
        selected={choice}
        onSelect={(path) => isShellPath(path) && setChoice(path)}
      />
      <div className={POPUP_ACTIONS}>
        <button type="button" className={POPUP_BUTTON} onClick={close}>
          {t("containerFiles.pickerCancel")}
        </button>
        <button
          type="button"
          disabled={!canOpen}
          className={POPUP_BUTTON_PRIMARY}
          onClick={() => {
            if (!canOpen) return;
            close();
            onOpen(choice);
          }}
        >
          {t("containerFiles.terminalOpen")}
        </button>
      </div>
    </>
  );
}

// Interop with the operating system clipboard. Pure helpers: the paste-event
// handling lives in ContainerFileManager, the Windows copy in osClipboardCopy.

/** Largest Copy that is also put on the OS clipboard (it is downloaded first). */
export const MAX_OS_COPY_BYTES = 512 * 1024 * 1024;

/** True when a Copy can also fill the OS file clipboard: Windows only. */
export function supportsOsFileClipboard(
  platform: string | null | undefined,
): boolean {
  return platform === "win32";
}

/** Known bytes of the copied files (folders count 0; the transfer checks them). */
export function knownBytes(items: { size?: number; type: string }[]): number {
  let sum = 0;
  for (const i of items)
    if (i.type !== "directory" && Number.isFinite(i.size)) sum += i.size ?? 0;
  return sum;
}

export function exceedsCopyCap(bytes: number): boolean {
  return bytes > MAX_OS_COPY_BYTES;
}

interface PasteData {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{
    kind: string;
    getAsFile(): File | null;
  }> | null;
}

/** Files on a paste event's clipboard (files copied in Explorer or Finder). */
export function extractPasteFiles(data: PasteData | null | undefined): File[] {
  if (!data) return [];
  const out: File[] = [];
  const add = (file: File | null | undefined) => {
    if (
      file &&
      !out.some(
        (f) =>
          f === file ||
          (f.name === file.name &&
            f.size === file.size &&
            f.lastModified === file.lastModified),
      )
    )
      out.push(file);
  };
  for (const f of Array.from(data.files ?? [])) add(f);
  if (out.length === 0)
    for (const item of Array.from(data.items ?? []))
      if (item.kind === "file") add(item.getAsFile());
  return out;
}

/**
 * A folder copied in Explorer arrives as an empty file without a type and
 * usually without an extension; it cannot be read.
 */
export function looksLikeFolder(file: {
  name: string;
  size: number;
  type: string;
}): boolean {
  return file.size === 0 && file.type === "" && !file.name.includes(".");
}

/** Typing, a menu or a dialog: a paste there is not for the file list. */
export function ignoresPaste(
  target: { closest?: (selector: string) => unknown } | null,
): boolean {
  return !!target?.closest?.(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="alertdialog"], [role="menu"]',
  );
}

/**
 * The folder an Explorer paste goes into: the single selected folder,
 * otherwise the folder the pane shows.
 */
export function pasteTargetDir(
  currentDir: string,
  selection: { path: string; type: string }[],
): string {
  return selection.length === 1 && selection[0].type === "directory"
    ? selection[0].path
    : currentDir;
}

/**
 * Which clipboard a paste uses. The OS clipboard has no timestamp, so it is
 * taken as set when the window last regained focus (that is when the user
 * comes back from Explorer); the internal one is set by Copy / Cut here.
 * The one set last wins; with no internal clipboard the OS one does.
 */
export function clipboardWinner(state: {
  hasInternal: boolean;
  internalAt: number;
  osAt: number;
}): "internal" | "os" {
  if (!state.hasInternal) return "os";
  return state.internalAt > state.osAt ? "internal" : "os";
}

/** Ctrl/Cmd+V on any keyboard layout: the letter, or its physical key (a Russian layout types "м"). */
export function isPasteKey(event: { key: string; code?: string }): boolean {
  return event.key === "v" || event.key === "V" || event.code === "KeyV";
}

/** True for the Latin letter, which is what the grid's own Ctrl+V handler listens to. */
export function typesLatinV(event: { key: string }): boolean {
  return event.key === "v" || event.key === "V";
}

/**
 * What a Ctrl+V does in Termix Desktop on Windows once the Explorer clipboard
 * was read: paste the internal clipboard (the files in it are our own copy, they
 * are the very paths the internal clipboard holds, or Explorer has nothing),
 * upload what Explorer copied, or say there is nothing.
 */
export function explorerPasteAction(state: {
  fileCount: number;
  own: boolean;
  hasInternal: boolean;
  /** The files are exactly the local paths of the internal clipboard. */
  matchesInternal?: boolean;
}): "internal" | "upload" | "empty" {
  if (state.fileCount === 0 || state.own || state.matchesInternal)
    return state.hasInternal ? "internal" : "empty";
  return "upload";
}

const normalizePath = (path: string) =>
  path
    .replace(/[\\/]+/g, "/")
    .replace(/(.)\/$/, "$1")
    .toLowerCase();

/** True when both lists name the same set of local paths (case, slash and order do not matter). */
export function samePaths(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  const left = new Set(a.map(normalizePath));
  const right = new Set(b.map(normalizePath));
  return left.size === right.size && [...right].every((p) => left.has(p));
}

let internalAt = 0;
let osAt = 0;
let tracking = false;

/** A Copy or Cut set the internal clipboard (any pane, any way: keys, menu, toolbar). */
export function markInternalClipboard(now = Date.now()): void {
  internalAt = now;
}

/** The window regained focus: the OS clipboard may have changed. */
export function markOsClipboard(now = Date.now()): void {
  osAt = now;
}

/** The internal clipboard was emptied (a pasted Cut): it no longer wins. */
export function invalidateInternalClipboard(): void {
  internalAt = 0;
}

/** Forgets both times (tests). */
export function resetClipboardClock(): void {
  internalAt = 0;
  osAt = 0;
}

export function clipboardTimes(): { internalAt: number; osAt: number } {
  return { internalAt, osAt };
}

/** Starts noting when the window regains focus (idempotent). */
export function trackWindowFocus(): void {
  if (tracking || typeof window === "undefined") return;
  tracking = true;
  const mark = () => markOsClipboard();
  window.addEventListener("focus", mark);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") mark();
  });
}

let folderHintShown = false;
/** True once: the hint about folders is shown a single time. */
export function takeFolderHint(): boolean {
  if (folderHintShown) return false;
  folderHintShown = true;
  return true;
}

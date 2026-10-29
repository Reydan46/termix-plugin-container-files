// The workspace clipboard shared by every pane: Copy / Cut in one pane, Paste
// in another. Pure helpers only; the workspace holds the state and runs the
// transfers (conflict window, progress, cancel) through useWorkspaceTransfers.

export type ClipMode = "copy" | "cut";

export interface ClipItem {
  path: string;
  name: string;
  isDirectory: boolean;
}

export interface PaneClipboard {
  /** The pane the items were copied or cut in. */
  paneId: string;
  /** null = the local (this computer) pane. */
  containerId: string | null;
  items: ClipItem[];
  mode: ClipMode;
}

/** Where a paste goes: a pane, and the container it shows (null = local). */
export interface PasteDestination {
  paneId: string;
  containerId: string | null;
}

/**
 * - none: nothing to paste.
 * - own: the pane's own clipboard handles it (same container pane).
 * - transfer: the drag-and-drop transfer machinery moves the items.
 * - unsupported: no way to do it here (copying within this computer).
 */
export type PasteKind = "none" | "own" | "transfer" | "unsupported";

export function makeClipboard(
  paneId: string,
  containerId: string | null,
  items: ClipItem[],
  mode: ClipMode,
): PaneClipboard | null {
  return items.length === 0 ? null : { paneId, containerId, items, mode };
}

export function pasteKind(
  clip: PaneClipboard | null,
  dest: PasteDestination,
): PasteKind {
  if (!clip || clip.items.length === 0) return "none";
  if (clip.paneId === dest.paneId)
    return dest.containerId === null ? "unsupported" : "own";
  if (clip.containerId === null && dest.containerId === null)
    return "unsupported";
  return "transfer";
}

/** Paths shown dimmed in `paneId`: only a cut, only in the pane it came from. */
export function cutPaths(
  clip: PaneClipboard | null,
  paneId: string,
): ReadonlySet<string> {
  if (!clip || clip.mode !== "cut" || clip.paneId !== paneId)
    return EMPTY_PATHS;
  return new Set(clip.items.map((i) => i.path));
}

const EMPTY_PATHS: ReadonlySet<string> = new Set();

/** The clipboard after a paste: a cut is spent when it worked, a copy stays. */
export function afterPaste(
  clip: PaneClipboard,
  ok: boolean,
): PaneClipboard | null {
  return ok && clip.mode === "cut" ? null : clip;
}

/**
 * The folder a paste goes into: the single selected folder, otherwise the
 * folder the pane shows.
 */
export function resolvePasteTarget(
  currentDir: string,
  selection: { path: string; isDirectory: boolean }[],
): string {
  return selection.length === 1 && selection[0].isDirectory
    ? selection[0].path
    : currentDir;
}

/** CSS that dims the rows of `paths` inside the element marked `data-clip-scope`. */
export function cutDimCss(scope: string, paths: ReadonlySet<string>): string {
  if (paths.size === 0) return "";
  const q = (s: string) =>
    `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ")}"`;
  const rows = [...paths]
    .map((p) => `[data-clip-scope=${q(scope)}] [data-file-path=${q(p)}]`)
    .join(",");
  return `${rows}{opacity:.5}`;
}

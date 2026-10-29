import type { FileItem } from "../vendor/file-manager/host-types";
import type { PaneViewState } from "./layout";

/** What a ContainerFileManager exposes to the workspace. */
export interface PaneApi {
  getDir(): string;
  refresh(): void;
  isDirectory(path: string): boolean;
  /** Selected items right now (for drag fallbacks). */
  getSelection(): FileItem[];
}

/**
 * Optional hook points the workspace gives to a ContainerFileManager. Without
 * a bridge the manager behaves as a standalone single pane.
 */
export interface PaneBridge {
  paneId: string;
  /** View state restored from the last session. */
  initial?: PaneViewState;
  saveState(state: PaneViewState): void;
  register(api: PaneApi | null): void;
  /** Items were copied or cut in this pane. */
  setClipboard(items: FileItem[], cut: boolean): void;
  /** The workspace holds a clipboard from another pane. */
  hasClipboard: boolean;
  /**
   * Paths on this computer held by the workspace clipboard (a Copy or Cut in
   * the local pane), else null. Lets a Ctrl+V recognise them on the OS clipboard.
   */
  localClipboardPaths(): string[] | null;
  /** Paths this pane cut that wait for a paste (shown dimmed). */
  cutPaths: ReadonlySet<string>;
  /** The workspace clipboard holds items copied or cut in this pane. */
  ownsClipboard: boolean;
  /** Empties the workspace clipboard (Escape). */
  clearClipboard(): void;
  /**
   * Paste into `destDir` of this pane. Resolves true when the workspace took
   * care of it (clipboard from another pane), false when the pane's own
   * clipboard applies.
   */
  paste(destDir: string): Promise<boolean>;
  /**
   * Uploads files and folders of this computer (Desktop; what Explorer put on
   * the OS clipboard) into `destDir` of this pane, through the same transfer a
   * drop from the local pane uses. Resolves true when the transfer ran.
   */
  pasteLocalPaths(
    destDir: string,
    items: { path: string; name: string; isDirectory: boolean }[],
  ): Promise<boolean>;
}

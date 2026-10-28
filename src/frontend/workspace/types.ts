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

export interface WorkspaceClipboard {
  paneId: string;
  containerId: string;
  files: { path: string; name: string; isDirectory: boolean }[];
  cut: boolean;
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
   * Paste into `destDir` of this pane. Resolves true when the workspace took
   * care of it (clipboard from another pane), false when the pane's own
   * clipboard applies.
   */
  paste(destDir: string): Promise<boolean>;
}

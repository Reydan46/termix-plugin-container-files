import { toast } from "sonner";
import type { TranslateFn } from "@termix-ssh/plugin-sdk/frontend";
import {
  cancelTransfer,
  localDownload,
  newTransferId,
  transferStatus,
} from "./containerFsApi";
import {
  exceedsCopyCap,
  invalidateInternalClipboard,
  samePaths,
  knownBytes,
  MAX_OS_COPY_BYTES,
  supportsOsFileClipboard,
} from "./osClipboard";
import { formatBytes } from "./UploadProgressToast";
import { clipboardPost, localPlatform } from "./osClipboardApi";
import { clipboardErrorText } from "./osClipboardErrors";
import { isLocalFileBrowserAvailable } from "./vendor/file-manager/lib/local-files";
import { TransferToast } from "./workspace/TransferToast";

interface CopyItem {
  name: string;
  path: string;
  type: string;
  size?: number;
}

let running: AbortController | null = null;
let cancelRunning: (() => void) | null = null;

/**
 * A newer Copy or Cut anywhere replaced the clipboard: stop a container copy
 * that is still downloading so it cannot land on the OS clipboard afterwards.
 */
export function supersedeOsCopy(): void {
  const stop = cancelRunning;
  running = null;
  cancelRunning = null;
  stop?.();
}

/** The paths this plugin last put on the OS clipboard from the local pane. */
let lastLocalCopy: string[] | null = null;

let unloadHooked = false;
function cleanOnClose() {
  if (unloadHooked) return;
  unloadHooked = true;
  window.addEventListener("pagehide", () => {
    void clipboardPost("clear", {}).catch(() => undefined);
  });
}

/**
 * Desktop on Windows: after Copy in a container pane, downloads the items to a
 * temp directory of this computer and lists them on the OS clipboard so
 * Explorer can paste them. Does nothing outside Desktop on Windows; every failure there shows a toast with the reason. The internal clipboard is set by
 * the caller and keeps working whatever happens here.
 */
export async function copyToOsClipboard({
  t,
  sessionId,
  containerId,
  items,
}: {
  t: TranslateFn;
  sessionId: string;
  containerId: string;
  items: CopyItem[];
}): Promise<void> {
  if (!isLocalFileBrowserAvailable() || items.length === 0) return;
  let platform: string | null;
  try {
    platform = await localPlatform();
  } catch (error) {
    toast.error(
      t("containerFiles.osClipboardFailed", {
        error: clipboardErrorText(error, t),
      }),
    );
    return;
  }
  if (!supportsOsFileClipboard(platform)) return;
  if (exceedsCopyCap(knownBytes(items))) {
    toast.warning(
      t("containerFiles.osClipboardTooLarge", {
        limit: formatBytes(MAX_OS_COPY_BYTES),
      }),
    );
    return;
  }
  supersedeOsCopy();
  const controller = new AbortController();
  running = controller;
  cleanOnClose();
  const transferId = newTransferId("clip");
  cancelRunning = () => {
    controller.abort();
    void cancelTransfer(transferId, "local");
  };
  let loaded = 0;
  let total = 0;
  let closed = false;
  let tooLarge = false;
  const title = t("containerFiles.osClipboardPreparing", {
    count: items.length,
  });
  const cancel = {
    label: t("fileManager.cancel"),
    onClick: () => {
      controller.abort();
      void cancelTransfer(transferId, "local");
    },
  };
  const render = () => {
    if (closed || controller.signal.aborted) return;
    toast.loading(
      <TransferToast t={t} title={title} loaded={loaded} total={total} />,
      { id, duration: Infinity, cancel },
    );
  };
  const id = toast.loading(title, { cancel, duration: Infinity });
  let poll: ReturnType<typeof setInterval> | undefined;
  try {
    const { dir } = await clipboardPost("prepare", {});
    if (!dir) throw new Error(t("containerFiles.osClipboardNoTempDir"));
    render();
    poll = setInterval(() => {
      void transferStatus(transferId, "local").then((s) => {
        if (!s || closed) return;
        loaded = s.bytes;
        total = s.total;
        if (exceedsCopyCap(Math.max(s.total, s.bytes)) && !tooLarge) {
          tooLarge = true;
          controller.abort();
          void cancelTransfer(transferId, "local");
          return;
        }
        render();
      });
    }, 500);
    const res = await localDownload(
      sessionId,
      {
        transferId,
        containerId,
        paths: items.map((i) => i.path),
        localDir: dir,
      },
      controller.signal,
    );
    if (controller.signal.aborted) throw new Error("aborted");
    const skipped = new Set(res.skipped ?? []);
    const names = items.map((i) => i.name).filter((n) => !skipped.has(n));
    if (res.success === false || names.length === 0)
      throw new Error(t("workspace.nothingWritten"));
    await clipboardPost("set", { dir, names });
    toast.success(
      t("containerFiles.osClipboardReady", { count: names.length }),
    );
  } catch (error) {
    if (tooLarge) {
      toast.warning(
        t("containerFiles.osClipboardTooLarge", {
          limit: formatBytes(MAX_OS_COPY_BYTES),
        }),
      );
    } else if (!controller.signal.aborted) {
      toast.error(
        t("containerFiles.osClipboardFailed", {
          error: clipboardErrorText(error, t),
        }),
      );
    }
    // A newer Copy owns the temp directory now: leave it alone.
    if (running === controller)
      void clipboardPost("clear", {}).catch(() => undefined);
  } finally {
    closed = true;
    clearInterval(poll);
    toast.dismiss(id);
    if (running === controller) {
      running = null;
      cancelRunning = null;
    }
  }
}

/**
 * Desktop on Windows: after Copy or Cut in the local pane, lists the real
 * paths on the OS clipboard (nothing is copied) so the newest Copy owns it and
 * Explorer can paste them. Silent elsewhere; a failure shows a toast with the
 * reason and the internal clipboard keeps working.
 */
export async function copyLocalToOsClipboard({
  t,
  paths,
}: {
  t: TranslateFn;
  paths: string[];
}): Promise<void> {
  supersedeOsCopy();
  if (!isLocalFileBrowserAvailable() || paths.length === 0) return;
  try {
    if (!supportsOsFileClipboard(await localPlatform())) return;
    await clipboardPost("set-paths", { paths });
    lastLocalCopy = paths;
  } catch (error) {
    toast.error(
      t("containerFiles.osClipboardFailed", {
        error: clipboardErrorText(error, t),
      }),
    );
  }
}

/**
 * After a Cut from the local pane was pasted: the moved paths are gone, so an
 * OS clipboard that still lists exactly them must not stay (a later Ctrl+V in a
 * container pane would upload missing files). Only a record equal to `moved`
 * is cleared; a newer Explorer copy is left alone. Silent on failure.
 */
export async function clearOsClipboardAfterCut(moved: string[]): Promise<void> {
  invalidateInternalClipboard();
  if (!lastLocalCopy || !samePaths(lastLocalCopy, moved)) return;
  lastLocalCopy = null;
  try {
    if (!supportsOsFileClipboard(await localPlatform())) return;
    await clipboardPost("clear-paths", { paths: moved });
  } catch {
    /* the paste itself succeeded */
  }
}

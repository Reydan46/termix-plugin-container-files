// Shim: the upstream module speaks SFTP over a session id; here the "session
// id" is a container target key and everything goes to /containers/... routes.
import { getApp } from "../../../app";
import {
  ContainerApiError,
  downloadBlob,
  fsApi,
  joinPath,
  listFiles,
  parseTarget,
  readTextFile,
  saveBlob,
  sessionApi,
  writeTextFile,
} from "../../../containerFsApi";
import type { FileItem } from "../host-types";
import { isPreviewableKind, previewSizeLimit } from "../../../mediaPreview";
import { notifyEditRejected } from "../../../editGate";
import { resolveFilePreviewKind } from "../file-preview-preload";
import { throttleProgress } from "./preview-progress";

/** Content strings starting with this are object URLs, not file data. */
export const BLOB_URL_PREFIX = "blob:";

/** The src for a viewer element: an object URL as is, else a base64 data URL. */
export function mediaSource(content: string, mime: string): string {
  return content.startsWith(BLOB_URL_PREFIX)
    ? content
    : `data:${mime};base64,${content}`;
}

/**
 * Downloads media and PDFs into a Blob and returns an object URL for the
 * viewer (the caller revokes it). Aborts as soon as the size is known to exceed
 * what the browser can hold (see mediaPreview.ts).
 */
async function downloadAsObjectUrl(
  sessionId: string,
  path: string,
  kind: string,
  outer?: AbortSignal,
  onProgress?: (loaded: number, total?: number) => void,
): Promise<string> {
  const limit = previewSizeLimit(kind);
  const controller = new AbortController();
  const report = onProgress && throttleProgress(onProgress);
  let tooLarge = false;
  // The viewer closing (or switching file) stops the download at once.
  const onOuterAbort = () => controller.abort();
  if (outer?.aborted) onOuterAbort();
  else outer?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const { blob } = await downloadBlob(sessionId, path, "file", {
      signal: controller.signal,
      onProgress: (loaded, total) => {
        report?.(loaded, total);
        if ((total ?? loaded) > limit) {
          tooLarge = true;
          controller.abort();
        }
      },
    });
    if (outer?.aborted) throw new DOMException("Aborted", "AbortError");
    return URL.createObjectURL(blob);
  } catch (error) {
    // Whatever the browser reports for a cancelled fetch, the caller sees an abort.
    if (outer?.aborted) throw new DOMException("Aborted", "AbortError");
    if (tooLarge)
      throw new ContainerApiError(
        "The file is too large to preview in this browser. Download it instead.",
      );
    throw error;
  } finally {
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

export async function listSSHFiles(
  sessionId: string,
  path: string,
  _options: { force?: boolean } = {},
): Promise<{ files: FileItem[]; path: string }> {
  const { files, path: resolved } = await listFiles(sessionId, path);
  return { files, path: resolved };
}

export async function createSSHFolder(
  sessionId: string,
  path: string,
  folderName: string,
  _hostId?: number,
): Promise<Record<string, unknown>> {
  return fsApi.mkdir(sessionId, joinPath(path, folderName));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function readSSHFile(
  sessionId: string,
  path: string,
  options: {
    force?: boolean;
    signal?: AbortSignal;
    /** Download progress of a media/PDF preview (throttled). */
    onProgress?: (loaded: number, total?: number) => void;
  } = {},
): Promise<{
  content: string;
  path: string;
  encoding?: "base64" | "utf8" | "blob-url";
}> {
  const kind = resolveFilePreviewKind(path.split("/").pop() ?? path);
  if (isPreviewableKind(kind)) {
    const url = await downloadAsObjectUrl(
      sessionId,
      path,
      kind,
      options.signal,
      options.onProgress,
    );
    // The viewer may have closed while the result was on its way: nobody owns
    // the object URL any more, so free it here instead of leaking the Blob.
    if (options.signal?.aborted) {
      URL.revokeObjectURL(url);
      throw new DOMException("Aborted", "AbortError");
    }
    return { content: url, path, encoding: "blob-url" };
  }
  try {
    const file = await readTextFile(sessionId, path);
    return { content: file.content, path, encoding: "utf8" };
  } catch (error) {
    const reason =
      error instanceof ContainerApiError
        ? error.code === "BINARY"
          ? "binary"
          : error.code === "TOO_LARGE"
            ? "tooLarge"
            : null
        : null;
    // The file manager that owns the window closes it and offers a download.
    // The promise then stays pending on purpose: the window is being closed,
    // so the viewer neither shows an empty editor nor raises its own error.
    // Without an owner the error is thrown and the editor shows it.
    if (reason && notifyEditRejected(sessionId, path, reason)) {
      return new Promise<never>(() => {});
    }
    if (reason !== "binary") throw error;
    // Without an owner, binary content reaches the viewer as base64.
    const { blob } = await downloadBlob(sessionId, path, "file");
    return { content: await blobToBase64(blob), path, encoding: "base64" };
  }
}

export async function writeSSHFile(
  sessionId: string,
  path: string,
  content: string,
): Promise<Record<string, unknown>> {
  return { ...(await writeTextFile(sessionId, path, content)) };
}

export async function getSSHStatus(
  sessionId: string,
): Promise<{ connected: boolean }> {
  const status = await sessionApi.status(parseTarget(sessionId).sessionId);
  return { connected: status.connected };
}

/** The container tab connects before any file view mounts. */
export async function connectSSH(
  _sessionId?: string,
  _config?: unknown,
): Promise<never> {
  throw new Error(getApp().t("containerFiles.sessionClosed"));
}

export async function setSudoPassword(
  _sessionId?: string,
  _password?: string,
): Promise<void> {
  // Not applicable: operations run as the container's user.
}

export interface DownloadProgressEvent {
  loaded: number;
  total?: number;
}

export async function downloadSSHFileStream(
  sessionId: string,
  filePath: string,
  onProgress?: (event: DownloadProgressEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { blob, fileName } = await downloadBlob(sessionId, filePath, "file", {
    signal,
    onProgress: (loaded, total) => onProgress?.({ loaded, total }),
  });
  saveBlob(blob, fileName);
}

export interface DownloadedSSHFile {
  /** base64-encoded file contents */
  content: string;
  fileName: string;
  size: number;
  mimeType: string;
  path: string;
}

export async function downloadSSHFile(
  sessionId: string,
  filePath: string,
): Promise<DownloadedSSHFile> {
  const { blob, fileName } = await downloadBlob(sessionId, filePath, "file");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return {
    content: btoa(binary),
    fileName,
    size: bytes.length,
    mimeType: blob.type || "application/octet-stream",
    path: filePath,
  };
}

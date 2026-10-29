// Browser (Web mode) transfer helpers: dropped-folder traversal, upload
// planning and streaming a download straight to disk. Everything that does
// not need the DOM is pure so it can be unit-tested with fake entries.
import { getApp } from "./app";

export interface UploadPlan {
  /** `rel` is the path under the destination directory, "/" separated. */
  files: { file: File; rel: string }[];
  /** Folders that contain nothing and so would vanish with a file-only upload. */
  emptyDirs: string[];
}

/** Joins relative path parts with "/", dropping empty parts. */
export function joinRel(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("/");
}

/** First segment of a relative path: the name that can collide in the target dir. */
export function topLevelOf(rel: string): string {
  return rel.split("/")[0];
}

/** False for paths that would climb out of the destination. */
export function isSafeRel(rel: string): boolean {
  if (!rel || rel.startsWith("/")) return false;
  return rel.split("/").every((s) => s !== ".." && s !== "." && s !== "");
}

/** Reads every entry of a directory (readEntries returns batches). */
async function readAll(
  dir: FileSystemDirectoryEntry,
): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return out;
    out.push(...batch);
  }
}

async function walk(
  entry: FileSystemEntry,
  prefix: string,
  plan: UploadPlan,
): Promise<void> {
  const rel = joinRel(prefix, entry.name);
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    if (isSafeRel(rel)) plan.files.push({ file, rel });
    return;
  }
  const children = await readAll(entry as FileSystemDirectoryEntry);
  if (children.length === 0) {
    if (isSafeRel(rel)) plan.emptyDirs.push(rel);
    return;
  }
  for (const child of children) await walk(child, rel, plan);
}

/**
 * Flattens dropped entries (files and folders, recursively) into files with
 * their relative paths plus the empty folders.
 */
export async function collectEntries(
  entries: FileSystemEntry[],
): Promise<UploadPlan> {
  const plan: UploadPlan = { files: [], emptyDirs: [] };
  for (const entry of entries) await walk(entry, "", plan);
  return plan;
}

/** Items of an `<input webkitdirectory>` or a plain multiple-file input. */
export function fromFileList(list: ArrayLike<File>): UploadPlan {
  const plan: UploadPlan = { files: [], emptyDirs: [] };
  for (const file of Array.from(list)) {
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name;
    if (isSafeRel(rel)) plan.files.push({ file, rel });
  }
  return plan;
}

/** Empty folders that no uploaded file already creates. */
export function dirsToCreate(plan: UploadPlan): string[] {
  const implied = new Set<string>();
  for (const { rel } of plan.files) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      implied.add(parts.slice(0, i).join("/"));
    }
  }
  return plan.emptyDirs.filter((d) => !implied.has(d));
}

// ---- streaming download -------------------------------------------------

interface WritableLike {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface SaveHandleLike {
  createWritable(): Promise<WritableLike>;
}

type SavePicker = (options: {
  suggestedName: string;
}) => Promise<SaveHandleLike>;

function picker(): SavePicker | undefined {
  const w = globalThis as { showSaveFilePicker?: SavePicker };
  return typeof w.showSaveFilePicker === "function"
    ? w.showSaveFilePicker.bind(globalThis)
    : undefined;
}

/** True when a download can go to disk without being held in memory. */
export function canStreamToDisk(): boolean {
  return picker() !== undefined;
}

/**
 * Asks where to save. Call it straight from the click (before any await) so
 * the browser still sees a user gesture. Rejects with an AbortError when the
 * user dismisses the dialog.
 */
export function pickSaveHandle(suggestedName: string): Promise<SaveHandleLike> {
  const pick = picker();
  if (!pick)
    return Promise.reject(
      new Error(getApp().t("containerFiles.saveUnsupported")),
    );
  return pick({ suggestedName });
}

/** Copies a response body into the chosen file chunk by chunk. */
export async function pipeToHandle(
  body: ReadableStream<Uint8Array>,
  handle: SaveHandleLike,
  options: {
    signal?: AbortSignal;
    onProgress?: (loaded: number) => void;
  } = {},
): Promise<number> {
  const writable = await handle.createWritable();
  const reader = body.getReader();
  let loaded = 0;
  try {
    for (;;) {
      if (options.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      loaded += value.length;
      options.onProgress?.(loaded);
    }
    await writable.close();
    return loaded;
  } catch (error) {
    // Discards the partial file instead of leaving a truncated one behind.
    await writable.abort(error).catch(() => undefined);
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

// The one place that talks to this plugin's /containers/... routes. The vendored
// File Manager code addresses everything by a "session id" string; here that
// string is a target key: "<sshSessionId>|<containerId>".

import { getApp } from "./app";
import type { MountInfo } from "./mountLookup";
import { isVirtualPath, parseVirtualPath, virtualPath } from "./archivePath";
import {
  originOfSession,
  originPrefix,
  via,
  type Origin,
} from "./sessionOrigin";
import type {
  FileItem,
  FileListMeta,
  ConnectResult,
  ContainerInfo,
  Capabilities,
} from "./types";

export class ContainerApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ContainerApiError";
  }
}

export function targetKey(sessionId: string, containerId: string): string {
  return `${sessionId}|${containerId}`;
}

export function parseTarget(key: string): {
  sessionId: string;
  containerId: string;
} {
  const i = key.lastIndexOf("|");
  if (i < 0) throw new ContainerApiError("Invalid container target");
  return { sessionId: key.slice(0, i), containerId: key.slice(i + 1) };
}

interface AxiosLike {
  message?: string;
  response?: {
    status?: number;
    data?: { error?: string; message?: string; code?: string } & Record<
      string,
      unknown
    >;
  };
}

/**
 * Every 404 this plugin sends carries a `code`; one without it came from the
 * host for a route the installed plugin does not have, which means the plugin
 * on that server is older than this client (fs/du, append, mounts...).
 */
export function isMissingRoute(
  status: number | undefined,
  code: string | undefined,
): boolean {
  return status === 404 && !code;
}

export const SERVER_OLDER_CODE = "SERVER_OLDER";

function olderServerError(status: number, data?: Record<string, unknown>) {
  return new ContainerApiError(
    getApp().t("containerFiles.serverOlder"),
    status,
    SERVER_OLDER_CODE,
    data,
  );
}

export function toApiError(error: unknown, action: string): ContainerApiError {
  if (error instanceof ContainerApiError) return error;
  const e = error as AxiosLike;
  const data = e?.response?.data;
  if (isMissingRoute(e?.response?.status, data?.code))
    return olderServerError(404, data);
  const message =
    data?.error ||
    data?.message ||
    (error instanceof Error ? error.message : `Failed to ${action}`);
  return new ContainerApiError(message, e?.response?.status, data?.code, data);
}

async function call<T>(action: string, run: () => Promise<{ data: T }>) {
  try {
    return (await run()).data;
  } catch (error) {
    throw toApiError(error, action);
  }
}

const enc = encodeURIComponent;

// Every route is built with via(): a remote session's calls go through the
// local backend's /remote proxy.
function base(key: string): string {
  const { sessionId, containerId } = parseTarget(key);
  return via(key, `/containers/${enc(sessionId)}/${enc(containerId)}`);
}

// ---- session ------------------------------------------------------------

export interface Credentials {
  userProvidedPassword?: string;
  userProvidedSshKey?: string;
  userProvidedKeyPassword?: string;
}

export const sessionApi = {
  connect: (sessionId: string, hostId: number, credentials?: Credentials) =>
    call<ConnectResult>("connect", () =>
      getApp().api.post(via(sessionId, "/ssh/connect"), {
        sessionId,
        hostId,
        ...credentials,
      }),
    ),
  answerTotp: (sessionId: string, totpCode: string) =>
    call<ConnectResult>("verify the code", () =>
      getApp().api.post(via(sessionId, "/ssh/connect-totp"), {
        sessionId,
        totpCode,
      }),
    ),
  continueBrowserSignIn: (sessionId: string) =>
    call<ConnectResult>("continue after a browser sign-in", () =>
      getApp().api.post(via(sessionId, "/ssh/connect-browser-sign-in"), {
        sessionId,
      }),
    ),
  disconnect: (sessionId: string) =>
    call("disconnect", () =>
      getApp().api.post(via(sessionId, "/ssh/disconnect"), { sessionId }),
    ),
  keepalive: (sessionId: string) =>
    call("keep the session alive", () =>
      getApp().api.post(via(sessionId, "/ssh/keepalive"), { sessionId }),
    ),
  status: (sessionId: string) =>
    call<{
      connected: boolean;
      runtime?: "docker" | "podman";
      runtimeVersion?: string | null;
    }>("get the status", () =>
      getApp().api.get(via(sessionId, "/ssh/status"), {
        params: { sessionId },
      }),
    ),
  containers: (sessionId: string) =>
    call<{ runtime: "docker" | "podman"; containers: ContainerInfo[] }>(
      "list containers",
      () => getApp().api.get(via(sessionId, `/containers/${enc(sessionId)}`)),
    ),
  capabilities: (key: string) =>
    call<Capabilities>("probe the container", () =>
      getApp().api.get(`${base(key)}/capabilities`),
    ),
  state: (key: string) =>
    call<ContainerLiveState>("read the container state", () =>
      getApp().api.get(`${base(key)}/state`),
    ),
  action: (key: string, action: ContainerAction) =>
    call<ContainerLiveState & { success: boolean }>(
      `${action} the container`,
      () => getApp().api.post(`${base(key)}/action`, { action }),
    ),
};

export type ContainerAction =
  "start" | "stop" | "restart" | "pause" | "unpause";

export interface ContainerLiveState {
  id: string;
  name: string;
  running: boolean;
  state: string;
  capabilities: Capabilities;
}

export interface Principals {
  users: { name: string; uid: number; gid: number; home?: string }[];
  groups: { name: string; gid: number }[];
}

export function fetchPrincipals(key: string): Promise<Principals> {
  return call<Principals>("read users and groups", () =>
    getApp().api.get(`${base(key)}/fs/principals`),
  );
}

export interface ContainerShells {
  /** Absolute paths of usable shells inside the container. */
  shells: string[];
  /** The shell to start by default, if one is known. */
  default: string | null;
}

/** Shells found in the container; a missing route counts as "none found". */
export async function fetchShells(key: string): Promise<ContainerShells> {
  try {
    const data = await call<Partial<ContainerShells>>("list shells", () =>
      getApp().api.get(`${base(key)}/shells`),
    );
    return {
      shells: Array.isArray(data.shells) ? data.shells : [],
      default: typeof data.default === "string" ? data.default : null,
    };
  } catch (error) {
    if (error instanceof ContainerApiError && error.status === 404)
      return { shells: [], default: null };
    throw error;
  }
}

/** Mounts of the container; a missing route counts as "none". */
export async function fetchMounts(
  key: string,
  signal?: AbortSignal,
): Promise<MountInfo[]> {
  try {
    const data = await call<{ mounts?: MountInfo[] }>("list mounts", () =>
      getApp().api.get(`${base(key)}/mounts`, { signal }),
    );
    return Array.isArray(data.mounts) ? data.mounts : [];
  } catch (error) {
    if (error instanceof ContainerApiError && error.status === 404) return [];
    throw error;
  }
}

// ---- listing ------------------------------------------------------------

export interface WireEntry {
  name: string;
  /** The backend sends "link"; "symlink" is accepted for tar-style names. */
  type: "file" | "directory" | "link" | "symlink" | "other";
  size: number;
  mtime: number;
  mode: number;
  owner: string;
  group: string;
  linkTarget?: string;
  linkKind?: "directory" | "file" | "missing";
}

export function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
}

export function toFileItem(
  key: string,
  dir: string,
  entry: WireEntry,
): FileItem {
  // A link is shown as what it points at, so folders open like folders.
  const type: FileItem["type"] =
    entry.type === "directory"
      ? "directory"
      : entry.type === "link" || entry.type === "symlink"
        ? entry.linkKind === "directory"
          ? "directory"
          : entry.linkKind === "file"
            ? "file"
            : "link"
        : "file";
  return {
    name: entry.name,
    path: joinPath(dir, entry.name),
    type,
    sshSessionId: key,
    size: entry.size,
    modified: new Date(entry.mtime * 1000).toISOString(),
    modifiedTimestamp: entry.mtime * 1000,
    permissions: (entry.mode & 0o7777).toString(8).padStart(3, "0"),
    owner: entry.owner,
    group: entry.group,
    linkTarget: entry.linkTarget,
    executable: (entry.mode & 0o111) !== 0 && type === "file",
  };
}

export interface ListResult {
  files: FileItem[];
  path: string;
  meta: FileListMeta;
}

export async function listFiles(
  key: string,
  path: string,
  options: { signal?: AbortSignal; onChunk?: (files: FileItem[]) => void } = {},
): Promise<ListResult> {
  const response = await getApp().fetch(
    `${base(key)}/fs/list?path=${enc(path)}`,
    { signal: options.signal },
  );
  if (!response.ok) throw await responseError(response, "list files");
  const files: FileItem[] = [];
  let meta: FileListMeta = { path, tier: "find", truncated: false, total: 0 };

  const handle = (line: string) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line) as {
      meta?: FileListMeta;
      entries?: WireEntry[];
      done?: boolean;
      error?: string;
    };
    if (msg.error) throw new ContainerApiError(msg.error);
    if (msg.meta) meta = msg.meta;
    if (msg.entries) {
      const items = msg.entries.map((e) => toFileItem(key, meta.path, e));
      files.push(...items);
      options.onChunk?.(items);
    }
  };

  if (!response.body) {
    (await response.text()).split("\n").forEach(handle);
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    handle(buffer + decoder.decode());
  }
  return { files, path: meta.path, meta };
}

/** Lists one folder of an archive (read-only); `dir` is a virtual path. */
export async function listArchiveFolder(
  key: string,
  dir: string,
  signal?: AbortSignal,
): Promise<ListResult> {
  const v = parseVirtualPath(dir);
  if (!v) throw new ContainerApiError("Not an archive path", 400);
  const response = await getApp().fetch(
    `${base(key)}/fs/archive/list?archive=${enc(v.archive)}&path=${enc(v.inner)}`,
    { signal },
  );
  if (!response.ok) throw await responseError(response, "open the archive");
  const data = (await response.json()) as {
    entries: WireEntry[];
    truncated: boolean;
    total: number;
  };
  const here = virtualPath(v.archive, v.inner);
  return {
    files: data.entries.map((e) => toFileItem(key, here, e)),
    path: here,
    meta: {
      path: here,
      tier: "cp",
      truncated: data.truncated,
      total: data.total,
    },
  };
}

/** Lists one folder of an archive by plain archive path and inner path. */
export async function listArchiveEntries(
  key: string,
  archive: string,
  inner: string,
  signal?: AbortSignal,
): Promise<{ entries: WireEntry[]; truncated: boolean; total: number }> {
  const response = await getApp().fetch(
    `${base(key)}/fs/archive/list?archive=${enc(archive)}&path=${enc(inner)}`,
    { signal },
  );
  if (!response.ok) throw await responseError(response, "open the archive");
  return (await response.json()) as {
    entries: WireEntry[];
    truncated: boolean;
    total: number;
  };
}

const READ_ONLY_ARCHIVE = "Archives are read-only";

function assertWritable(path: string): void {
  if (parseVirtualPath(path)) {
    throw new ContainerApiError(READ_ONLY_ARCHIVE, 405, "READ_ONLY");
  }
}

export async function responseError(
  response: Response,
  action: string,
): Promise<ContainerApiError> {
  let data: Record<string, unknown> | undefined;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  if (isMissingRoute(response.status, data?.code as string | undefined))
    return olderServerError(response.status, data);
  const message =
    (data?.error as string) ||
    (data?.message as string) ||
    `Failed to ${action} (${response.status})`;
  return new ContainerApiError(
    message,
    response.status,
    data?.code as string | undefined,
    data,
  );
}

// ---- operations ---------------------------------------------------------

/** Lets a long operation be tracked (opId) and aborted (signal). */
export interface OpTrack {
  opId?: string;
  signal?: AbortSignal;
}

function op<T = Record<string, unknown>>(
  key: string,
  name: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) {
  for (const value of Object.values(body)) {
    if (typeof value === "string") assertWritable(value);
    else if (Array.isArray(value)) {
      for (const item of value)
        if (typeof item === "string") assertWritable(item);
    }
  }
  return call<T>(name, () =>
    getApp().api.post(`${base(key)}/fs/${name}`, body, { signal }),
  );
}

/** A top level name an extraction creates. */
export interface ExtractPlanItem {
  name: string;
  isDirectory: boolean;
}

/** The answers of the conflict window: names to leave out, and name -> new name. */
export interface ExtractChoices {
  skip: string[];
  renames: Record<string, string>;
  /** Existing names the user chose to replace; others are never overwritten. */
  replace: string[];
}

/** What a recursive chmod/chown touches. */
export type ApplyScope = "all" | "files" | "dirs";

export const fsApi = {
  mkdir: (key: string, path: string) => op(key, "mkdir", { path }),
  create: (key: string, path: string) => op(key, "create", { path }),
  rename: (key: string, from: string, to: string, overwrite = false) =>
    op(key, "rename", { from, to, overwrite }),
  move: (key: string, from: string, to: string, overwrite = false) =>
    op(key, "move", { from, to, overwrite }),
  copy: (key: string, from: string, to: string, overwrite = false) =>
    op(key, "copy", { from, to, overwrite }),
  delete: (key: string, paths: string[]) => op(key, "delete", { paths }),
  chmod: (
    key: string,
    path: string,
    mode: string,
    recursive = false,
    scope: ApplyScope = "all",
  ) => op(key, "chmod", { path, mode, recursive, scope }),
  chown: (
    key: string,
    path: string,
    owner: string,
    recursive = false,
    scope: ApplyScope = "all",
  ) => op(key, "chown", { path, owner, recursive, scope }),
  symlink: (key: string, target: string, path: string, force = false) =>
    op(key, "symlink", { target, path, force }),
  compress: (
    key: string,
    dir: string,
    names: string[],
    out: string,
    format: "tar" | "tgz" | "zip",
    track: OpTrack = {},
  ) =>
    op(
      key,
      "compress",
      { dir, names, out, format, opId: track.opId },
      track.signal,
    ),
  append: (
    key: string,
    archive: string,
    dir: string,
    names: string[],
    track: OpTrack = {},
  ) =>
    op(key, "append", { archive, dir, names, opId: track.opId }, track.signal),
  archiveDelete: (
    key: string,
    archive: string,
    entries: string[],
    track: OpTrack = {},
  ) =>
    op(
      key,
      "archive-delete",
      { archive, entries, opId: track.opId },
      track.signal,
    ),
  extract: (
    key: string,
    archive: string,
    dest: string,
    overwrite = false,
    track: OpTrack = {},
    choices?: ExtractChoices,
  ) =>
    op(
      key,
      "extract",
      { archive, dest, overwrite, opId: track.opId, ...choices },
      track.signal,
    ),
  /**
   * The top level names an extraction creates (all of the archive, or just
   * `entries`). An older server answers with SERVER_OLDER_CODE.
   */
  extractPlan: (key: string, archive: string, entries?: string[]) =>
    call<{ items: ExtractPlanItem[]; truncated?: boolean }>(
      "plan the extraction",
      () =>
        getApp().api.post(`${base(key)}/fs/extract-plan`, { archive, entries }),
    ),
  /** Extracts chosen entries (archive-inner paths) into `dest`. */
  extractEntries: (
    key: string,
    archive: string,
    entries: string[],
    dest: string,
    overwrite = false,
    track: OpTrack = {},
    choices?: ExtractChoices,
  ) => {
    assertWritable(dest);
    return call<{ ok: boolean }>("extract entries", () =>
      getApp().api.post(
        `${base(key)}/fs/extract-entries`,
        {
          archive,
          entries,
          dest,
          overwrite,
          opId: track.opId,
          ...choices,
        },
        { signal: track.signal },
      ),
    );
  },
  sha256: (key: string, path: string) =>
    op<{ sha256: string }>(key, "sha256", { path }),
  stat: (key: string, path: string) =>
    call<WireEntry>("stat", () =>
      getApp().api.get(`${base(key)}/fs/stat`, { params: { path } }),
    ),
};

// ---- editor -------------------------------------------------------------

export interface TextFile {
  content: string;
  size: number;
  mtime: number;
  mode: number;
}

export function readTextFile(key: string, path: string): Promise<TextFile> {
  const v = parseVirtualPath(path);
  if (v) {
    return call<TextFile>("read the file", () =>
      getApp().api.get(`${base(key)}/fs/archive/entry`, {
        params: { archive: v.archive, path: v.inner },
      }),
    );
  }
  return call<TextFile>("read the file", () =>
    getApp().api.get(`${base(key)}/fs/read`, { params: { path } }),
  );
}

export async function writeTextFile(
  key: string,
  path: string,
  content: string,
  expectedMtime?: number,
): Promise<{ mtime: number; size: number }> {
  assertWritable(path);
  const query = new URLSearchParams({ path });
  if (expectedMtime !== undefined) {
    query.set("expectedMtime", String(expectedMtime));
  }
  const response = await getApp().fetch(`${base(key)}/fs/write?${query}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: new TextEncoder().encode(content),
  });
  if (!response.ok) throw await responseError(response, "save the file");
  return (await response.json()) as { mtime: number; size: number };
}

// ---- transfers ----------------------------------------------------------

export function newTransferId(prefix = "cf"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** True for the blob fallback's refusal of a body over `maxBytes`. */
export function isTooLargeDownload(error: unknown): boolean {
  return error instanceof ContainerApiError && error.code === "TOO_LARGE";
}

/** Largest body the blob fallback (no File System Access API) will hold in memory. */
export const MAX_BUFFERED_DOWNLOAD = 256 * 1024 * 1024;

/** Starts a download and returns the raw response; the caller consumes the body. */
export async function openDownload(
  key: string,
  path: string,
  kind: "file" | "directory",
  options: { transferId?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  const transferId = options.transferId ?? newTransferId("dl");
  const v = parseVirtualPath(path);
  if (v && kind === "directory") {
    throw new ContainerApiError(
      "Folders inside an archive cannot be downloaded; extract the archive first",
      400,
      "NOT_A_FILE",
    );
  }
  const response = await getApp().fetch(
    v
      ? `${base(key)}/fs/archive/entry?archive=${enc(v.archive)}&path=${enc(v.inner)}&download=1`
      : `${base(key)}/transfer/download?path=${enc(path)}&kind=${kind}&transferId=${enc(transferId)}`,
    { signal: options.signal },
  );
  if (!response.ok) throw await responseError(response, "download");
  return response;
}

export function downloadFallbackName(
  path: string,
  kind: "file" | "directory",
): string {
  return (
    (path.split("/").pop() || "download") + (kind === "directory" ? ".tar" : "")
  );
}

export async function downloadBlob(
  key: string,
  path: string,
  kind: "file" | "directory",
  options: {
    transferId?: string;
    signal?: AbortSignal;
    onProgress?: (loaded: number, total?: number) => void;
    /** Refuse bodies larger than this instead of buffering them. */
    maxBytes?: number;
  } = {},
): Promise<{ blob: Blob; fileName: string }> {
  const response = await openDownload(key, path, kind, options);
  const total = Number(response.headers.get("content-length")) || undefined;
  const tooLarge = () =>
    new ContainerApiError(
      "This download is too large for this browser; use Chrome or Edge to save it to disk",
      413,
      "TOO_LARGE",
    );
  const parts: Uint8Array[] = [];
  let loaded = 0;
  if (options.maxBytes && total && total > options.maxBytes) {
    void response.body?.cancel();
    throw tooLarge();
  }
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.length;
      if (options.maxBytes && loaded > options.maxBytes) {
        void reader.cancel();
        throw tooLarge();
      }
      options.onProgress?.(loaded, total);
    }
  }
  const type =
    response.headers.get("content-type") ?? "application/octet-stream";
  const fallback =
    (path.split("/").pop() || "download") +
    (kind === "directory" ? ".tar" : "");
  return {
    blob: new Blob(parts as BlobPart[], { type }),
    fileName:
      dispositionName(response.headers.get("content-disposition")) ?? fallback,
  };
}

function dispositionName(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // fall through
    }
  }
  const plain = /filename="([^"]*)"/i.exec(header);
  return plain ? plain[1] : null;
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function uploadFile(
  key: string,
  dir: string,
  file: Blob,
  target: { name?: string; rel?: string },
  options: {
    overwrite?: boolean;
    transferId?: string;
    signal?: AbortSignal;
    mode?: number;
    mtime?: number;
  } = {},
): Promise<{ bytes: number }> {
  const query = new URLSearchParams({
    dir,
    format: "file",
    transferId: options.transferId ?? newTransferId("up"),
  });
  if (target.rel) query.set("rel", target.rel);
  else query.set("name", target.name ?? "upload");
  if (options.overwrite) query.set("overwrite", "1");
  if (options.mode !== undefined) query.set("mode", String(options.mode));
  if (options.mtime !== undefined) query.set("mtime", String(options.mtime));
  const response = await getApp().fetch(
    `${base(key)}/transfer/upload?${query}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
      signal: options.signal,
    },
  );
  if (!response.ok) throw await responseError(response, "upload");
  return (await response.json()) as { bytes: number };
}

export interface TransferStatus {
  id: string;
  state: "running" | "done" | "error" | "cancelled";
  bytes: number;
  total: number;
  error?: string;
}

/** `origin` is where the transfer runs: "local" also for this-computer halves. */
export function transferStatus(
  transferId: string,
  origin: Origin,
): Promise<TransferStatus | null> {
  return getApp()
    .api.get(`${originPrefix(origin)}/transfers/${enc(transferId)}`)
    .then((r: { data: TransferStatus }) => r.data)
    .catch(() => null);
}

export function cancelTransfer(
  transferId: string,
  origin: Origin,
): Promise<unknown> {
  return getApp()
    .api.post(`${originPrefix(origin)}/transfers/${enc(transferId)}/cancel`, {})
    .catch(() => undefined);
}

// ---- container to container --------------------------------------------

export interface CopyBetweenBody {
  transferId: string;
  from: { containerId: string; paths: string[] };
  to: { containerId: string; dir: string };
  /** Source top-level name -> new name (keep both). */
  renames?: Record<string, string>;
  /** Source top-level names to leave out. */
  skip?: string[];
}

export function copyBetween(
  sessionId: string,
  body: CopyBetweenBody,
  signal?: AbortSignal,
): Promise<{ success: boolean; copied: number; bytes?: number }> {
  if (
    isVirtualPath(body.to.dir) ||
    body.from.paths.some((path) => isVirtualPath(path))
  )
    return Promise.reject(
      new Error(getApp().t("containerFiles.archiveReadOnly")),
    );
  return call("copy between containers", () =>
    getApp().api.post(
      via(sessionId, `/containers/${enc(sessionId)}/copy`),
      body,
      {
        signal,
      },
    ),
  );
}

// ---- desktop: this computer <-> container -------------------------------

export interface LocalUploadBody {
  transferId: string;
  containerId: string;
  dir: string;
  localPaths: string[];
  renames?: Record<string, string>;
  skip?: string[];
}

export interface LocalDownloadBody {
  transferId: string;
  containerId: string;
  paths: string[];
  localDir: string;
  renames?: Record<string, string>;
  skip?: string[];
}

/**
 * Desktop only: uploads files and folders of the user's computer. The call
 * always goes to this device's backend; for a session on the server it moves
 * the container half through the link (`origin: "remote"`).
 */
export function localUpload(
  sessionId: string,
  body: LocalUploadBody,
  signal?: AbortSignal,
): Promise<{ success: boolean; bytes?: number }> {
  if (isVirtualPath(body.dir))
    return Promise.reject(
      new Error(getApp().t("containerFiles.archiveReadOnly")),
    );
  return call("upload from this computer", () =>
    getApp().api.post(
      "/local/transfer/upload",
      { sessionId, ...body, origin: originOfSession(sessionId) },
      { signal },
    ),
  );
}

/** Desktop only: downloads container files and folders to the user's computer. */
export function localDownload(
  sessionId: string,
  body: LocalDownloadBody,
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  bytes?: number;
  files?: number;
  dirs?: number;
  skipped?: string[];
  bytesWritten?: number;
}> {
  if (body.paths.some((path) => isVirtualPath(path)))
    return Promise.reject(
      new Error(getApp().t("containerFiles.archiveReadOnly")),
    );
  return call("download to this computer", () =>
    getApp().api.post(
      "/local/transfer/download",
      { sessionId, ...body, origin: originOfSession(sessionId) },
      { signal },
    ),
  );
}

/** What the backend reports for a running compress / extract. */
export interface OpStatus {
  status: "running" | "done" | "error" | "cancelled";
  stage:
    | "preparing"
    | "scanning"
    | "packing"
    | "extracting"
    | "rewriting"
    | "finishing";
  processedBytes?: number;
  totalBytes?: number;
  approximate?: boolean;
}

export function operationStatus(
  opId: string,
  origin: Origin,
): Promise<OpStatus | null> {
  return getApp()
    .api.get(`${originPrefix(origin)}/operations/${enc(opId)}`)
    .then((r: { data: OpStatus }) => r.data)
    .catch(() => null);
}

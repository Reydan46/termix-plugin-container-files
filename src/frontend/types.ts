import type { ConnectionStage } from "@termix-ssh/plugin-sdk/ui";
import type { FileItem } from "./vendor/file-manager/host-types";

export type { FileItem };

export type Runtime = "docker" | "podman";

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  created: string;
}

export interface Capabilities {
  running: boolean;
  exec: boolean;
  findPrintf: boolean;
  statC: boolean;
  tools: string[];
  tarFlavor?: "gnu" | "busybox" | "bsd" | "other";
  /** Absent when the server plugin is older: then try and map the error. */
  appendSupport?: AppendSupport;
  /** Same for deleting entries from an archive (absent on an older server). */
  deleteSupport?: DeleteSupport;
  /** Why exec is unavailable (absent when it works). */
  reason?: LimitReason;
  status?: string;
  /** First line of the failing probe's stderr. */
  detail?: string;
  rootless?: boolean;
}

export type AppendVerdict =
  | { ok: true }
  | { ok: false; reason: "busybox-tar" | "no-tool"; tool?: string };

/** An older server sends only the first five kinds. */
export type AppendSupport = Partial<Record<AppendKind, AppendVerdict>>;

export type AppendKind = "zip" | "tar" | "tgz" | "tbz" | "txz" | "tzst" | "7z";

export type DeleteVerdict =
  { ok: true } | { ok: false; reason: "gnu-tar" | "no-tool"; tool?: string };

export type DeleteSupport = Partial<Record<AppendKind, DeleteVerdict>>;

export type LimitReason =
  "stopped" | "paused" | "exec-denied" | "no-shell" | "exec-failed";

export interface FileListMeta {
  path: string;
  tier: "find" | "stat" | "cp";
  truncated: boolean;
  total: number;
}

export interface ApiConnectionLog {
  type: "info" | "success" | "warning" | "error";
  stage: ConnectionStage;
  message: string;
  details?: string;
}

/** One step of a connect: connected, a prompt to answer, or auth needed. */
export interface ConnectResult {
  success?: boolean;
  status?: string;
  reason?: string;
  message?: string;
  runtime?: Runtime;
  runtimeVersion?: string | null;
  requires_totp?: boolean;
  prompt?: string;
  isPassword?: boolean;
  retry?: boolean;
  requires_browser_sign_in?: boolean;
  url?: string | null;
  code?: string;
  label?: string;
  connectionLogs?: ApiConnectionLog[];
}

/** What the views read from the host a tab was opened on. */
export interface ContainerHost {
  id: number;
  name?: string;
  ip: string;
  port: number;
  username?: string;
}

export function containerName(c: Pick<ContainerInfo, "name">): string {
  return c.name.startsWith("/") ? c.name.slice(1) : c.name;
}

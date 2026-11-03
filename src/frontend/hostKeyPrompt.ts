import type { ConnectResult } from "./types";

/** What the host key dialog shows, as the connect step sent it. */
export interface HostKeyInfo {
  scenario: "new" | "changed";
  ip: string;
  port: number;
  hostname?: string;
  fingerprint: string;
  oldFingerprint?: string;
  keyType: string;
  oldKeyType?: string;
  algorithm: string;
}

/** The question in a connect result, or null when the result is not one. */
export function hostKeyInfoOf(result: ConnectResult): HostKeyInfo | null {
  if (!result.requires_host_key || !result.fingerprint) return null;
  return {
    scenario: result.scenario === "changed" ? "changed" : "new",
    ip: result.ip ?? "",
    port: result.port ?? 22,
    hostname: result.hostname,
    fingerprint: result.fingerprint,
    oldFingerprint: result.oldFingerprint,
    keyType: result.keyType ?? "unknown",
    oldKeyType: result.oldKeyType,
    algorithm: result.algorithm ?? "sha256",
  };
}

/**
 * The translated message for a connect that ended on an answer a retry cannot
 * change: the host key was turned down, or the host has no docker or podman.
 * Retrying by itself would only meet the same answer again, so the retry waits
 * for the person. Null for any other failure.
 */
export function settledFailureKey(
  code: string | undefined,
):
  | "containerFiles.hostKeyRejected"
  | "containerFiles.hostKeyTimeout"
  | "containerFiles.noRuntime"
  | null {
  if (code === "HOST_KEY_REJECTED") return "containerFiles.hostKeyRejected";
  if (code === "HOST_KEY_TIMEOUT") return "containerFiles.hostKeyTimeout";
  if (code === "NO_RUNTIME") return "containerFiles.noRuntime";
  return null;
}

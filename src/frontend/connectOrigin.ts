// The pure part of the connect flow: which backend a host connects through and
// whether something blocks it. The UI injects the SDK calls.

import { newSessionId, type Origin } from "./sessionOrigin";

export type BlockedKey =
  | "remoteNotLinked"
  | "remoteHostMissing"
  | "remotePluginMissing"
  | "remoteUnavailable"
  | "remoteSignedOut";

export type ConnectPlan =
  | { kind: "ready"; origin: Origin; hostId: number; sessionId: string }
  | { kind: "blocked"; key: BlockedKey };

/** Web has no local backend of its own: the host's setting only applies on Desktop. */
export async function pickOrigin(
  desktopAvailable: boolean,
  resolve: () => Promise<Origin>,
): Promise<Origin> {
  return desktopAvailable ? resolve() : "local";
}

/** Maps a failed preflight to a blocking message; null lets the connect try. */
export function preflightBlock(error: unknown): BlockedKey | null {
  const e = error as { status?: number; code?: string } | null;
  const status = e?.status;
  const code = e?.code;
  if (code === "REMOTE_UNAVAILABLE") return "remoteUnavailable";
  if (code === "NOT_DESKTOP") return "remoteNotLinked";
  if (status === 401 || code === "REMOTE_SIGNED_OUT") return "remoteSignedOut";
  // Our own routes always answer with a code; a bare 404 means no plugin there.
  if (status === 404 && !code) return "remotePluginMissing";
  return null;
}

export async function planConnect(deps: {
  desktopAvailable: boolean;
  localHostId: number;
  resolveOrigin: () => Promise<Origin>;
  remoteServerUrl: () => Promise<string | null>;
  remoteHostId: () => Promise<number | null>;
  /** GET /remote/ssh/status for the new session; rejects on failure. */
  preflight: (sessionId: string) => Promise<unknown>;
}): Promise<ConnectPlan> {
  const origin = await pickOrigin(deps.desktopAvailable, deps.resolveOrigin);
  if (origin === "local") {
    return {
      kind: "ready",
      origin,
      hostId: deps.localHostId,
      sessionId: newSessionId("local"),
    };
  }
  if (!(await deps.remoteServerUrl()))
    return { kind: "blocked", key: "remoteNotLinked" };
  const hostId = await deps.remoteHostId();
  if (hostId === null || hostId === undefined)
    return { kind: "blocked", key: "remoteHostMissing" };
  const sessionId = newSessionId("remote");
  try {
    await deps.preflight(sessionId);
  } catch (error) {
    const key = preflightBlock(error);
    if (key) return { kind: "blocked", key };
  }
  return { kind: "ready", origin, hostId, sessionId };
}

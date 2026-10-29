// Which backend a session lives on, kept in the session id itself: "cf-..."
// for this device's backend, "cfr-..." for the linked server (reached through
// the local backend's /remote proxy). The id is opaque to the vendored File
// Manager code, so the origin has to travel inside it.

export type Origin = "local" | "remote";

const REMOTE_PREFIX = "cfr-";

export function newSessionId(origin: Origin = "local"): string {
  const prefix = origin === "remote" ? REMOTE_PREFIX : "cf-";
  return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/** Accepts a session id or a target key ("<sessionId>|<containerId>"). */
export function originOfSession(idOrKey: string): Origin {
  const i = idOrKey.lastIndexOf("|");
  const sessionId = i < 0 ? idOrKey : idOrKey.slice(0, i);
  return sessionId.startsWith(REMOTE_PREFIX) ? "remote" : "local";
}

/** The path prefix that sends a request to the linked server's backend. */
export function originPrefix(origin: Origin): string {
  return origin === "remote" ? "/remote" : "";
}

/** Prefixes a plugin route for the origin of the session it belongs to. */
export function via(idOrKey: string, path: string): string {
  return originPrefix(originOfSession(idOrKey)) + path;
}

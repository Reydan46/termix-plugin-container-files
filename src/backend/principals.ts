import { runCommand } from "./exec.js";
import { execScriptCommand } from "./shell-quote.js";
import type { ListTarget } from "./fs-list.js";

export interface PrincipalUser {
  name: string;
  uid: number;
  gid: number;
  home?: string;
}

export interface PrincipalGroup {
  name: string;
  gid: number;
}

export interface Principals {
  users: PrincipalUser[];
  groups: PrincipalGroup[];
}

const SEPARATOR = "--cf-groups--";
const SCRIPT = `cat /etc/passwd 2>/dev/null; echo; echo '${SEPARATOR}'; cat /etc/group 2>/dev/null; exit 0`;

const ID_RE = /^\d+$/;

/** Fields of the non-comment, non-empty lines of a passwd/group file. */
function records(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(":"));
}

/** Parses `/etc/passwd` (name:pw:uid:gid:gecos:home:shell); skips bad lines. */
export function parsePasswd(text: string): PrincipalUser[] {
  const users: PrincipalUser[] = [];
  for (const f of records(text)) {
    if (f.length < 4 || !f[0] || !ID_RE.test(f[2]) || !ID_RE.test(f[3])) {
      continue;
    }
    users.push({
      name: f[0],
      uid: Number(f[2]),
      gid: Number(f[3]),
      ...(f[5] ? { home: f[5] } : {}),
    });
  }
  return users;
}

/** Parses `/etc/group` (name:pw:gid:members); skips bad lines. */
export function parseGroup(text: string): PrincipalGroup[] {
  const groups: PrincipalGroup[] = [];
  for (const f of records(text)) {
    if (f.length < 3 || !f[0] || !ID_RE.test(f[2])) continue;
    groups.push({ name: f[0], gid: Number(f[2]) });
  }
  return groups;
}

export function parsePrincipals(output: string): Principals {
  const at = output.indexOf(SEPARATOR);
  const passwd = at < 0 ? output : output.slice(0, at);
  const group = at < 0 ? "" : output.slice(at + SEPARATOR.length);
  return { users: parsePasswd(passwd), groups: parseGroup(group) };
}

/** Users and groups of the container; empty lists when they can't be read. */
export async function readPrincipals(
  t: ListTarget,
  signal?: AbortSignal,
): Promise<Principals> {
  if (!t.capabilities.exec) return { users: [], groups: [] };
  try {
    const result = await runCommand(
      t.client,
      execScriptCommand(t.runtime, t.containerId, SCRIPT),
      { signal, timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 },
    );
    if (result.code !== 0) return { users: [], groups: [] };
    return parsePrincipals(result.stdout.toString("utf8"));
  } catch (error) {
    if (signal?.aborted) throw error;
    return { users: [], groups: [] };
  }
}

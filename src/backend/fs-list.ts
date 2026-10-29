import tar from "tar-stream";
import type { Client } from "ssh2";
import { openChannel, runCommand } from "./exec.js";
import { HttpError } from "./helpers.js";
import { execScriptCommand, type ContainerRuntime } from "./shell-quote.js";
import type { Capabilities } from "./capabilities.js";
import { cpFromCommand } from "./tar.js";

export type EntryType = "file" | "directory" | "link" | "other";

export interface FileEntry {
  name: string;
  type: EntryType;
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
  /** Permission bits, e.g. 0o755. */
  mode: number;
  owner: string;
  group: string;
  /** For links. */
  linkTarget?: string;
  /** What a link points at; "missing" for dangling ones. */
  linkKind?: "directory" | "file" | "missing";
}

export type ListTier = "find" | "stat" | "cp";

export interface ListResult {
  entries: FileEntry[];
  tier: ListTier;
  /** The path that was listed (a lookalike of the request when the fallback matched one). */
  path: string;
  /** The listing hit the size cap (cp tier only). */
  truncated: boolean;
}

export interface ListTarget {
  client: Client;
  runtime: ContainerRuntime;
  containerId: string;
  capabilities: Capabilities;
}

const LIST_TIMEOUT_MS = 60_000;
const MAX_LIST_BYTES = 256 * 1024 * 1024;
export const CP_LIST_CAP = 8 * 1024 * 1024;

/**
 * `[ -e ]` is false both for a missing path and for one that can't be stat'ed
 * (no search permission on a parent: bind mounts, ACLs). Ask `ls` which one it
 * is, and pass its message on in stderr so the error is diagnosable.
 */
const DIR_CHECK = `if [ ! -e "$1" ]; then e=$(ls -ld -- "$1" 2>&1 >/dev/null); [ -n "$e" ] && echo "$e" >&2; case "$e" in *"Permission denied"*) exit 46;; esac; exit 44; fi; [ -d "$1" ] || exit 45; [ -r "$1" ] && [ -x "$1" ] || { echo "cannot open directory '$1': Permission denied" >&2; exit 46; }; `;

/**
 * Used when DIR_CHECK rejected the path: enters the directory with `cd` (a
 * different syscall path than `[ -e ]`/`ls`) and lists "." from there.
 */
const CD_CHECK = `cd -- "$1" 2>/dev/null || exit 44; [ -r . ] || exit 46; `;

const findBody = (dir: string) =>
  `find -H ${dir} -mindepth 1 -maxdepth 1 -printf '%f\\0%y\\0%s\\0%T@\\0%m\\0%u\\0%g\\0%l\\0%Y\\0' 2>/dev/null; exit 0`;
const statBody = (dir: string) =>
  `find -H ${dir} -mindepth 1 -maxdepth 1 -exec stat -c '%F|%s|%Y|%a|%U|%G|%n' {} + 2>/dev/null; exit 0`;
const linksBody = (dir: string) =>
  `find -H ${dir} -mindepth 1 -maxdepth 1 -type l -exec sh -c 'for f; do t=$(readlink "$f"); if [ -d "$f" ]; then k=d; elif [ -e "$f" ]; then k=f; else k=m; fi; printf "%s\\0%s\\0%s\\0" "$f" "$k" "$t"; done' _ {} +`;

const FIND_SCRIPT = DIR_CHECK + findBody('"$1"');
const STAT_SCRIPT = DIR_CHECK + statBody('"$1"');
const LINKS_SCRIPT = linksBody('"$1"');
const FIND_FALLBACK_SCRIPT = CD_CHECK + findBody(".");
const STAT_FALLBACK_SCRIPT = CD_CHECK + statBody(".");
const LINKS_FALLBACK_SCRIPT = CD_CHECK + linksBody(".");

/**
 * Run after a failed check, to explain it: who we are, where, the exact bytes
 * of the path the container's shell received, and what `ls` says about it and
 * its parent.
 */
const DIAG_SCRIPT = `echo "uid=$(id -u 2>&1)"; echo "cwd=$(pwd 2>&1)"; echo "hex=$(printf '%s' "$1" | od -An -tx1 2>&1 | tr -d '\\n')"; echo "ls=$(ls -ld -- "$1" 2>&1 | tr '\\n' ' ')"; echo "parent=$(ls -ld -- "\${1%/*}/" 2>&1 | tr '\\n' ' ')"; exit 0`;

function typeFromFind(y: string): EntryType {
  if (y === "d") return "directory";
  if (y === "f") return "file";
  if (y === "l") return "link";
  return "other";
}

function linkKindFromFind(y: string): FileEntry["linkKind"] {
  if (y === "d") return "directory";
  if (y === "N" || y === "L" || y === "?" || y === "") return "missing";
  return "file";
}

/** Parses the NUL-separated output of FIND_SCRIPT (9 fields per entry). */
export function parseFindOutput(output: Buffer | string): FileEntry[] {
  const parts = output.toString("utf8").split("\0");
  const entries: FileEntry[] = [];
  for (let i = 0; i + 8 < parts.length; i += 9) {
    const [name, y, size, mtime, mode, owner, group, target, yDeref] =
      parts.slice(i, i + 9);
    const type = typeFromFind(y);
    const entry: FileEntry = {
      name,
      type,
      size: Number(size) || 0,
      mtime: Math.floor(Number(mtime)) || 0,
      mode: parseInt(mode, 8) || 0,
      owner,
      group,
    };
    if (type === "link") {
      entry.linkTarget = target;
      entry.linkKind = linkKindFromFind(yDeref);
    }
    entries.push(entry);
  }
  return entries;
}

function typeFromStat(f: string): EntryType {
  if (f === "directory") return "directory";
  if (f.startsWith("regular")) return "file";
  if (f === "symbolic link") return "link";
  return "other";
}

const STAT_LINE =
  /^([^|]+)\|(\d+)\|(-?\d+)\|([0-7]+)\|([^|]*)\|([^|]*)\|(.*)$/s;

/**
 * Parses STAT_SCRIPT output. The name comes last so it may contain `|`, and a
 * line that doesn't look like a record continues the previous name (names
 * with newlines).
 */
export function parseStatOutput(
  output: Buffer | string,
  dir: string,
): FileEntry[] {
  const prefix = dir === "/" ? "/" : `${dir}/`;
  const records: string[] = [];
  // The final newline ends the last record; it is not part of its name.
  for (const line of output.toString("utf8").replace(/\n$/, "").split("\n")) {
    if (STAT_LINE.test(line) || records.length === 0) records.push(line);
    else records[records.length - 1] += `\n${line}`;
  }
  const entries: FileEntry[] = [];
  for (const record of records) {
    const m = STAT_LINE.exec(record);
    if (!m) continue;
    const [, kind, size, mtime, mode, owner, group, path] = m;
    entries.push({
      name: path.startsWith(prefix) ? path.slice(prefix.length) : path,
      type: typeFromStat(kind),
      size: Number(size),
      mtime: Number(mtime),
      mode: parseInt(mode, 8),
      owner,
      group,
    });
  }
  return entries;
}

/** Applies LINKS_SCRIPT output (path, kind, target triples) to the entries. */
export function applyLinkInfo(
  entries: FileEntry[],
  output: Buffer | string,
  dir: string,
): void {
  const prefix = dir === "/" ? "/" : `${dir}/`;
  const parts = output.toString("utf8").split("\0");
  const byName = new Map(entries.map((e) => [e.name, e]));
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const [path, kind, target] = parts.slice(i, i + 3);
    const entry = byName.get(
      path.startsWith(prefix) ? path.slice(prefix.length) : path,
    );
    if (!entry) continue;
    entry.linkTarget = target;
    entry.linkKind =
      kind === "d" ? "directory" : kind === "f" ? "file" : "missing";
  }
}

/** What the diagnostics script reported about a failed path. */
export interface ListDiagnostics {
  exitCode: number | null;
  stderr: string;
  /** Path bytes (hex) as this plugin sent them. */
  sentHex: string;
  /** Path bytes (hex) as the container shell received them. */
  receivedHex?: string;
  uid?: string;
  cwd?: string;
  ls?: string;
  parent?: string;
  /** Variants of the path tried by the `cd` fallback. */
  triedVariants?: string[];
}

const hexOf = (value: string) =>
  Buffer.from(value, "utf8")
    .toString("hex")
    .replace(/(..)(?=.)/g, "$1 ");

/** Parses DIAG_SCRIPT output (`key=value` lines). */
function parseDiag(text: string): Partial<ListDiagnostics> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^(uid|cwd|hex|ls|parent)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return {
    uid: out.uid,
    cwd: out.cwd,
    receivedHex: out.hex,
    ls: out.ls,
    parent: out.parent,
  };
}

const oneLine = (text: string) => text.trim().replace(/\s*\r?\n\s*/g, " | ");

/** ": <path> (<full stderr>)" for error messages. */
function describe(dir: string, stderr: string): string {
  const text = oneLine(stderr);
  return text ? `: ${dir} (${text})` : `: ${dir}`;
}

/** Compact "[exit 44; uid 0; cwd /; sent 2f..; received 2f..]" suffix. */
function diagSuffix(d: ListDiagnostics): string {
  const parts = [`exit ${d.exitCode ?? "?"}`];
  if (d.uid) parts.push(`uid ${d.uid}`);
  if (d.cwd) parts.push(`cwd ${d.cwd}`);
  parts.push(`sent ${d.sentHex}`);
  if (d.receivedHex) parts.push(`received ${d.receivedHex}`);
  if (d.ls) parts.push(`ls: ${d.ls}`);
  if (d.parent) parts.push(`parent: ${d.parent}`);
  if (d.triedVariants?.length) parts.push(`cd tried ${d.triedVariants.length}`);
  return ` [${parts.join("; ")}]`;
}

/** Exit codes of DIR_CHECK. */
function failureForCode(
  code: number | null,
  dir: string,
  stderr: string,
  diag?: ListDiagnostics,
): HttpError | null {
  const detail = describe(dir, stderr) + (diag ? diagSuffix(diag) : "");
  const details = diag ? { ...diag } : undefined;
  if (code === 44) {
    return new HttpError(
      404,
      `Directory not found${detail}`,
      "NOT_FOUND",
      details,
    );
  }
  if (code === 45) {
    return new HttpError(
      400,
      `Not a directory${detail}`,
      "NOT_A_DIRECTORY",
      details,
    );
  }
  if (code === 46) {
    return new HttpError(
      403,
      `Permission denied${detail}`,
      "PERMISSION_DENIED",
      details,
    );
  }
  return null;
}

function failureFor(dir: string, stderr: string): HttpError {
  const text = stderr.trim();
  const detail = describe(dir, stderr);
  if (/no such file|not found/i.test(text)) {
    return new HttpError(404, `Directory not found${detail}`, "NOT_FOUND");
  }
  if (/not a directory/i.test(text)) {
    return new HttpError(400, `Not a directory${detail}`, "NOT_A_DIRECTORY");
  }
  if (/permission denied/i.test(text)) {
    return new HttpError(
      403,
      `Permission denied${detail}`,
      "PERMISSION_DENIED",
    );
  }
  return new HttpError(500, text || "Listing failed", "LIST_FAILED");
}

const INVISIBLE = "\u00a0\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\ufeff";
const EDGE_JUNK = new RegExp(`^[\\s${INVISIBLE}]+|[\\s${INVISIBLE}]+$`, "g");
const ANY_INVISIBLE = new RegExp(`[${INVISIBLE}]`, "g");

/**
 * The path itself, then lookalikes that differ only in invisible bytes or
 * Unicode normalization (names typed or pasted on another system).
 */
export function pathVariants(dir: string): string[] {
  const trimmed = dir.replace(EDGE_JUNK, "");
  const cleaned = dir
    .split("/")
    .map((s) => s.replace(ANY_INVISIBLE, "").trim())
    .join("/");
  const out = new Set<string>([dir]);
  for (const base of [dir, trimmed, cleaned]) {
    out.add(base);
    out.add(base.normalize("NFC"));
    out.add(base.normalize("NFD"));
  }
  return [...out].filter((p) => p.startsWith("/") && p.length > 0);
}

interface ShellScripts {
  primary: string;
  fallback: string;
}

/** Lists with `find`/`stat` in the container's shell, with diagnostics and a `cd` fallback. */
async function listViaShell(
  target: ListTarget,
  dir: string,
  tier: "find" | "stat",
  signal?: AbortSignal,
): Promise<ListResult> {
  const { client, runtime, containerId } = target;
  const scripts: ShellScripts =
    tier === "find"
      ? { primary: FIND_SCRIPT, fallback: FIND_FALLBACK_SCRIPT }
      : { primary: STAT_SCRIPT, fallback: STAT_FALLBACK_SCRIPT };
  const opts = { signal, timeoutMs: LIST_TIMEOUT_MS, maxBytes: MAX_LIST_BYTES };
  const run = (script: string, path: string) =>
    runCommand(
      client,
      execScriptCommand(runtime, containerId, script, [path]),
      opts,
    );

  let result = await run(scripts.primary, dir);
  let path = dir;
  let fellBack = false;
  const tried: string[] = [];
  const check = result;
  if (result.code === 44 || result.code === 45 || result.code === 46) {
    for (const candidate of pathVariants(dir)) {
      tried.push(candidate);
      const attempt = await run(scripts.fallback, candidate);
      if (attempt.code === 0) {
        result = attempt;
        path = candidate;
        fellBack = true;
        break;
      }
    }
  }

  if (result.code !== 0) {
    let diag: ListDiagnostics = {
      exitCode: check.code,
      stderr: check.stderr,
      sentHex: hexOf(dir),
      triedVariants: tried,
    };
    if (check.code === 44 || check.code === 46) {
      try {
        const probe = await run(DIAG_SCRIPT, dir);
        diag = { ...diag, ...parseDiag(probe.stdout.toString("utf8")) };
      } catch {
        // Diagnostics are best effort.
      }
    }
    throw (
      failureForCode(check.code, dir, check.stderr, diag) ??
      failureFor(dir, result.stderr)
    );
  }

  const base = fellBack ? "." : dir;
  const entries =
    tier === "find"
      ? parseFindOutput(result.stdout)
      : parseStatOutput(result.stdout, base);
  if (tier === "stat" && entries.some((e) => e.type === "link")) {
    const links = await run(
      fellBack ? LINKS_FALLBACK_SCRIPT : LINKS_SCRIPT,
      path,
    );
    if (links.code === 0) applyLinkInfo(entries, links.stdout, base);
  }
  return { entries, tier, truncated: false, path };
}

/** Lists a directory with the fastest method the container supports. */
export async function listDirectory(
  target: ListTarget,
  dir: string,
  signal?: AbortSignal,
): Promise<ListResult> {
  const { capabilities } = target;
  if (capabilities.exec && capabilities.findPrintf) {
    return listViaShell(target, dir, "find", signal);
  }
  if (capabilities.exec && capabilities.statC) {
    return listViaShell(target, dir, "stat", signal);
  }
  return listViaCp(target, dir, signal);
}

/**
 * Tar headers carry no link kind. A link to a sibling in the same listing
 * ("name" or "./name") can still be classified from that sibling; any other
 * target stays unknown and is resolved when the link is opened.
 */
export function resolveSiblingLinks(entries: Map<string, FileEntry>): void {
  for (const entry of entries.values()) {
    if (entry.type !== "link" || !entry.linkTarget) continue;
    const target = entry.linkTarget.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!target || target.includes("/")) continue;
    const sibling = entries.get(target);
    if (!sibling) continue;
    if (sibling.type === "directory") entry.linkKind = "directory";
    else if (sibling.type === "file") entry.linkKind = "file";
  }
}

/**
 * Last resort for containers without a usable shell (distroless, stopped):
 * reads the headers of `cp <dir> -` and keeps the direct children. The stream
 * also carries file contents, so only the first CP_LIST_CAP bytes are read.
 */
export async function listViaCp(
  target: ListTarget,
  dir: string,
  signal?: AbortSignal,
): Promise<ListResult> {
  const { client, runtime, containerId } = target;
  signal?.throwIfAborted();
  const channel = await openChannel(
    client,
    cpFromCommand(runtime, containerId, dir),
    signal,
  );
  const base = dir === "/" ? "" : dir.split("/").pop()!;
  const entries = new Map<string, FileEntry>();
  let bytes = 0;
  let truncated = false;
  let stderr = "";
  channel.stderr.on("data", (d: Buffer) => {
    if (stderr.length < 16 * 1024) stderr += d.toString();
  });

  return new Promise<ListResult>((resolve, reject) => {
    const extract = tar.extract();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      channel.destroy();
      if (error) reject(error);
      else {
        resolveSiblingLinks(entries);
        resolve({
          entries: [...entries.values()],
          tier: "cp",
          path: dir,
          truncated,
        });
      }
    };
    const onAbort = () => finish(new HttpError(499, "Cancelled", "CANCELLED"));
    signal?.addEventListener("abort", onAbort, { once: true });

    extract.on("entry", (header, stream, next) => {
      const rel = header.name.replace(/^\.\//, "").replace(/\/+$/, "");
      const segs = rel.split("/").filter(Boolean);
      const children = base ? segs.slice(1) : segs;
      if ((!base || segs[0] === base) && children.length === 1) {
        const name = children[0];
        const type: EntryType =
          header.type === "directory"
            ? "directory"
            : header.type === "file"
              ? "file"
              : header.type === "symlink"
                ? "link"
                : "other";
        entries.set(name, {
          name,
          type,
          size: header.size ?? 0,
          mtime: header.mtime ? Math.floor(header.mtime.getTime() / 1000) : 0,
          mode: (header.mode ?? 0) & 0o7777,
          owner: header.uname || String(header.uid ?? ""),
          group: header.gname || String(header.gid ?? ""),
          ...(type === "link" ? { linkTarget: header.linkname } : {}),
        });
      }
      stream.on("end", next);
      stream.resume();
    });
    extract.on("error", (e) => finish(e));
    extract.on("finish", () => finish());

    channel.on("data", (d: Buffer) => {
      bytes += d.length;
      if (bytes > CP_LIST_CAP) {
        truncated = true;
        finish();
        return;
      }
      if (!extract.write(d)) {
        channel.pause();
        extract.once("drain", () => channel.resume());
      }
    });
    channel.once("close", (code: number | null) => {
      if (settled) return;
      if (code !== 0 && code !== null && entries.size === 0) {
        finish(failureFor(dir, stderr));
        return;
      }
      extract.end(() => {});
    });
    channel.once("error", (e: Error) => finish(e));
  });
}

import { posix } from "node:path";
import { runCommand } from "./exec.js";
import { errorFromResult, requireExec, statPath } from "./fs-ops.js";
import type { FileEntry, ListTarget } from "./fs-list.js";
import { HttpError } from "./helpers.js";
import { execScriptCommand } from "./shell-quote.js";
import {
  parseDuKb,
  probe,
  watchProgress,
  type OpProgress,
} from "./op-progress.js";

/**
 * Read-only browsing of archives that sit in the container: the archive is
 * listed once with the container's own tar/unzip, parsed here and cached for a
 * short time. Nothing is extracted and no path from the archive is ever put
 * into a shell command except as a positional argument that must match a
 * listed entry.
 */

export const ARCHIVE_MAX_ENTRIES = 100_000;
export const ARCHIVE_ENTRY_MAX_BYTES = 64 * 1024 * 1024;
const LIST_MAX_BYTES = 48 * 1024 * 1024;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ARCHIVES = 6;
const ARCHIVE_TIMEOUT_MS = 2 * 60 * 1000;

export type ArchiveKind = "zip" | "tar" | "tgz" | "tbz" | "txz";

export interface ArchiveEntry {
  /** The name exactly as stored in the archive (used to extract it). */
  raw: string;
  /** Normalized absolute path inside the archive, no trailing slash. */
  path: string;
  type: "file" | "directory" | "link" | "other";
  size: number;
  mtime: number;
  mode: number;
  owner: string;
  group: string;
  linkTarget?: string;
}

export interface ArchiveListing {
  archive: string;
  path: string;
  entries: FileEntry[];
  /** More than ARCHIVE_MAX_ENTRIES entries: the rest is not shown. */
  truncated: boolean;
  total: number;
}

export function archiveKind(path: string): ArchiveKind | null {
  const p = path.toLowerCase();
  if (p.endsWith(".zip")) return "zip";
  if (p.endsWith(".tar.gz") || p.endsWith(".tgz")) return "tgz";
  if (p.endsWith(".tar.bz2") || p.endsWith(".tbz2")) return "tbz";
  if (p.endsWith(".tar.xz") || p.endsWith(".txz")) return "txz";
  if (p.endsWith(".tar")) return "tar";
  return null;
}

/** Normalizes a path inside an archive: absolute, no "." / ".." / trailing "/". */
export function innerPath(value: unknown): string {
  if (value === undefined || value === "") return "/";
  if (typeof value !== "string" || value.includes("\0")) {
    throw new HttpError(400, "Invalid path");
  }
  const n = posix.normalize(value.startsWith("/") ? value : `/${value}`);
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

function normalizeEntryName(raw: string): string | null {
  const n = posix.normalize(`/${raw}`).replace(/\/+$/, "");
  return n && n !== "/" ? n : null;
}

const MONTHS_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseWhen(date: string, time: string): number {
  let y: number, m: number, d: number;
  if (MONTHS_RE.test(date)) {
    [y, m, d] = date.split("-").map(Number);
  } else {
    // unzip on older systems: mm-dd-yy(yy)
    const [mm, dd, yy] = date.split("-").map(Number);
    m = mm;
    d = dd;
    y = yy < 100 ? (yy < 70 ? 2000 + yy : 1900 + yy) : yy;
  }
  const [hh, mi, ss = "0"] = time.split(":");
  const ms = Date.UTC(y, m - 1, d, Number(hh), Number(mi), Number(ss));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function modeFrom(perms: string): number {
  // "drwxr-xr-x" -> numeric permission bits (with setuid/setgid/sticky)
  const bits = perms.slice(1, 10);
  if (bits.length < 9) return 0o644;
  let mode = 0;
  for (let i = 0; i < 9; i++) {
    const c = bits[i];
    if (c !== "-" && c !== "S" && c !== "T") mode |= 1 << (8 - i);
  }
  if (bits[2] === "s" || bits[2] === "S") mode |= 0o4000;
  if (bits[5] === "s" || bits[5] === "S") mode |= 0o2000;
  if (bits[8] === "t" || bits[8] === "T") mode |= 0o1000;
  return mode;
}

// "-rw-r--r-- user/group 1234 2024-01-31 12:00[:00] name[ -> target]"
// Also matches GNU numeric owners and busybox's "user/group" column.
const TAR_LINE =
  /^([-dlhpcbs][-rwxsStT]{9})\S*\s+(\S+)\s+(\d+(?:,\d+)?)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s+(.*)$/;

/** Parses `tar -tv` output (GNU and busybox layouts). */
export function parseTarListing(output: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = TAR_LINE.exec(line);
    if (!m) continue;
    const [, perms, who, size, date, time, rest] = m;
    const kind = perms[0];
    let name = rest;
    let linkTarget: string | undefined;
    if (kind === "l") {
      const i = rest.indexOf(" -> ");
      if (i >= 0) {
        name = rest.slice(0, i);
        linkTarget = rest.slice(i + 4);
      }
    } else if (kind === "h") {
      const i = rest.indexOf(" link to ");
      if (i >= 0) name = rest.slice(0, i);
    }
    const path = normalizeEntryName(name);
    if (!path) continue;
    const [owner, group = ""] = who.split("/");
    entries.push({
      raw: name,
      path,
      type:
        kind === "d"
          ? "directory"
          : kind === "l"
            ? "link"
            : kind === "-" || kind === "h"
              ? "file"
              : "other",
      size: kind === "-" ? Number(size) : 0,
      mtime: parseWhen(date, time),
      mode: modeFrom(perms),
      owner,
      group,
      linkTarget,
    });
  }
  return entries;
}

// "  1234  2024-01-31 12:00   dir/name"  (or mm-dd-yy on older unzip)
const ZIP_LINE =
  /^\s*(\d+)\s+(\d{2,4}-\d{2}-\d{2,4})\s+(\d{2}:\d{2}(?::\d{2})?)\s+(.+)$/;

/** Parses `unzip -l` output. */
export function parseZipListing(output: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = ZIP_LINE.exec(line);
    if (!m) continue;
    const [, size, date, time, name] = m;
    const path = normalizeEntryName(name);
    if (!path) continue;
    const dir = name.endsWith("/");
    entries.push({
      raw: name,
      path,
      type: dir ? "directory" : "file",
      size: dir ? 0 : Number(size),
      mtime: parseWhen(date, time),
      mode: dir ? 0o755 : 0o644,
      owner: "",
      group: "",
    });
  }
  return entries;
}

/** The entries directly inside `dir`, with folders implied by deeper paths. */
export function childrenOf(entries: ArchiveEntry[], dir: string): FileEntry[] {
  const prefix = dir === "/" ? "/" : `${dir}/`;
  const found = new Map<string, FileEntry>();
  for (const e of entries) {
    if (!e.path.startsWith(prefix) || e.path === dir) continue;
    const rest = e.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    if (!name) continue;
    if (slash >= 0) {
      // Only deeper entries: the folder itself may have no entry of its own.
      if (!found.has(name)) {
        found.set(name, folderEntry(name, e.mtime));
      }
      continue;
    }
    const prior = found.get(name);
    // Later entries win (a tar can add a file again); a real folder entry
    // replaces the implied one.
    if (prior && e.type !== "directory" && prior.type === "directory") continue;
    found.set(name, {
      name,
      type: e.type,
      size: e.size,
      mtime: e.mtime,
      mode: e.mode,
      owner: e.owner,
      group: e.group,
      ...(e.linkTarget ? { linkTarget: e.linkTarget } : {}),
    });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function folderEntry(name: string, mtime: number): FileEntry {
  return {
    name,
    type: "directory",
    size: 0,
    mtime,
    mode: 0o755,
    owner: "",
    group: "",
  };
}

// ---- running tar / unzip ---------------------------------------------------

function toolFor(kind: ArchiveKind): "unzip" | "tar" {
  return kind === "zip" ? "unzip" : "tar";
}

function requireTool(t: ListTarget, kind: ArchiveKind): void {
  requireExec(t);
  const tool = toolFor(kind);
  if (!t.capabilities.tools.includes(tool)) {
    throw new HttpError(
      501,
      `${tool} is not installed in this container, so archives of this type cannot be opened`,
      "NO_TOOL",
    );
  }
}

const LIST_SCRIPT = `case "$1" in
  *.zip|*.ZIP) unzip -l "$1" ;;
  *.tar.gz|*.tgz|*.TGZ|*.TAR.GZ) tar -tvzf "$1" ;;
  *.tar.bz2|*.tbz2|*.TAR.BZ2) tar -tvjf "$1" ;;
  *.tar.xz|*.txz|*.TAR.XZ) tar -tvJf "$1" ;;
  *) tar -tvf "$1" ;;
esac`;

const CAT_SCRIPT = `case "$1" in
  *.zip|*.ZIP) unzip -p "$1" "$2" ;;
  *.tar.gz|*.tgz|*.TGZ|*.TAR.GZ) tar -xOzf "$1" -- "$2" ;;
  *.tar.bz2|*.tbz2|*.TAR.BZ2) tar -xOjf "$1" -- "$2" ;;
  *.tar.xz|*.txz|*.TAR.XZ) tar -xOJf "$1" -- "$2" ;;
  *) tar -xOf "$1" -- "$2" ;;
esac`;

interface Cached {
  at: number;
  entries: ArchiveEntry[];
  truncated: boolean;
  total: number;
}

const caches = new WeakMap<object, Map<string, Cached>>();

/** For tests. */
export function clearArchiveCache(): void {
  // WeakMap has no clear(); a generation counter invalidates every entry.
  generation += 1;
}
let generation = 0;

async function loadEntries(
  t: ListTarget,
  archive: string,
  kind: ArchiveKind,
  signal?: AbortSignal,
): Promise<Cached> {
  requireTool(t, kind);
  const stat = await statPath(t, archive, { signal });
  if (stat.type === "directory") {
    throw new HttpError(400, "Not an archive file", "NOT_A_FILE");
  }
  const key = `${generation}|${t.containerId}|${archive}|${stat.mtime}|${stat.size}`;
  let perClient = caches.get(t.client);
  if (!perClient) {
    perClient = new Map();
    caches.set(t.client, perClient);
  }
  const hit = perClient.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;

  const result = await runCommand(
    t.client,
    execScriptCommand(t.runtime, t.containerId, LIST_SCRIPT, [archive]),
    { signal, maxBytes: LIST_MAX_BYTES, timeoutMs: ARCHIVE_TIMEOUT_MS },
  ).catch((e) => {
    if (e instanceof HttpError && e.code === "TOO_LARGE") {
      throw new HttpError(413, "The archive has too many entries", "TOO_LARGE");
    }
    throw e;
  });
  if (result.code !== 0) throw errorFromResult(result);
  const text = result.stdout.toString("utf8");
  const parsed = kind === "zip" ? parseZipListing(text) : parseTarListing(text);
  const total = parsed.length;
  const cached: Cached = {
    at: Date.now(),
    entries: parsed.slice(0, ARCHIVE_MAX_ENTRIES),
    truncated: total > ARCHIVE_MAX_ENTRIES,
    total,
  };
  for (const [k, v] of perClient) {
    if (Date.now() - v.at >= CACHE_TTL_MS) perClient.delete(k);
  }
  while (perClient.size >= CACHE_MAX_ARCHIVES) {
    const oldest = perClient.keys().next().value;
    if (oldest === undefined) break;
    perClient.delete(oldest);
  }
  perClient.set(key, cached);
  return cached;
}

function kindOf(archive: string): ArchiveKind {
  const kind = archiveKind(archive);
  if (!kind) throw new HttpError(400, "Unsupported archive type");
  return kind;
}

/** Lists one folder of an archive. */
export async function listArchive(
  t: ListTarget,
  archive: string,
  dir: string,
  signal?: AbortSignal,
): Promise<ArchiveListing> {
  const kind = kindOf(archive);
  const cached = await loadEntries(t, archive, kind, signal);
  const entries = childrenOf(cached.entries, dir);
  if (
    dir !== "/" &&
    entries.length === 0 &&
    !cached.entries.some((e) => e.path === dir)
  ) {
    throw new HttpError(404, `Not found in the archive: ${dir}`, "NOT_FOUND");
  }
  return {
    archive,
    path: dir,
    entries,
    truncated: cached.truncated,
    total: cached.total,
  };
}

/** Reads one file out of an archive (bounded). */
export async function readArchiveEntry(
  t: ListTarget,
  archive: string,
  path: string,
  maxBytes: number = ARCHIVE_ENTRY_MAX_BYTES,
  signal?: AbortSignal,
): Promise<{ data: Buffer; entry: ArchiveEntry }> {
  const kind = kindOf(archive);
  const cached = await loadEntries(t, archive, kind, signal);
  const entry = [...cached.entries]
    .reverse()
    .find((e) => e.path === path && e.type !== "directory");
  if (!entry) {
    const isDir = cached.entries.some(
      (e) => e.path === path || e.path.startsWith(`${path}/`),
    );
    throw isDir
      ? new HttpError(400, "Is a directory", "NOT_A_FILE")
      : new HttpError(404, `Not found in the archive: ${path}`, "NOT_FOUND");
  }
  if (entry.type !== "file") {
    throw new HttpError(400, "Only regular files can be opened", "NOT_A_FILE");
  }
  if (entry.size > maxBytes) {
    throw new HttpError(413, "File too large", "TOO_LARGE");
  }
  if (entry.raw.startsWith("-")) {
    throw new HttpError(400, "Unsupported entry name");
  }
  // unzip treats [ ] * ? as patterns in member names; match literally.
  const member =
    kind === "zip" ? entry.raw.replace(/([\\*?[\]])/g, "\\$1") : entry.raw;
  const result = await runCommand(
    t.client,
    execScriptCommand(t.runtime, t.containerId, CAT_SCRIPT, [archive, member]),
    { signal, maxBytes, timeoutMs: ARCHIVE_TIMEOUT_MS },
  );
  if (result.code !== 0) throw errorFromResult(result);
  return { data: result.stdout, entry };
}

// ---- selective extraction ---------------------------------------------------

export const EXTRACT_MAX_ENTRIES = 500;

// Mirrors the shell `rel` function of EXTRACT_SCRIPT.
function shellRel(raw: string): string {
  let r = raw;
  for (;;) {
    if (r.startsWith("./")) r = r.slice(2);
    else if (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1);
    else return r;
  }
}

/**
 * Resolves chosen archive paths to the names stored in the archive. Folders
 * (also those that only exist because deeper entries imply them) resolve to
 * their own name, which tar and unzip extract together with their contents.
 */
export function resolveMembers(
  entries: ArchiveEntry[],
  chosen: string[],
): string[] {
  const unique = [...new Set(chosen)].sort((a, b) => a.length - b.length);
  const roots: string[] = [];
  for (const p of unique) {
    if (!roots.some((r) => p === r || p.startsWith(`${r}/`))) roots.push(p);
  }
  const members: string[] = [];
  for (const p of roots) {
    if (p === "/")
      throw new HttpError(400, "Choose entries inside the archive");
    let raw: string | undefined;
    const exact = [...entries].reverse().find((e) => e.path === p);
    if (exact) raw = exact.raw;
    else {
      const child = entries.find((e) => e.path.startsWith(`${p}/`));
      if (child)
        raw = child.raw.slice(
          0,
          child.raw.length - (child.path.length - p.length),
        );
    }
    if (raw === undefined) {
      throw new HttpError(404, `Not found in the archive: ${p}`, "NOT_FOUND");
    }
    if (
      raw.startsWith("-") ||
      raw.startsWith("/") ||
      /[\0\n]/.test(raw) ||
      raw.split("/").includes("..") ||
      shellRel(raw) !== p.slice(1)
    ) {
      throw new HttpError(400, `Unsupported entry name: ${p}`);
    }
    members.push(raw);
  }
  // Each member lands at "<dest>/<last name part>": equal names would collide.
  const seen = new Set<string>();
  for (const m of members) {
    const base = shellRel(m).split("/").pop()!;
    if (seen.has(base)) {
      throw new HttpError(
        409,
        `Several chosen entries are named "${base}"; extract them separately`,
        "EXISTS",
      );
    }
    seen.add(base);
  }
  return members;
}

// $1 archive, $2 destination, $3 overwrite, then the stored member names.
// Members are unpacked into a scratch folder inside the destination and then
// moved to "<destination>/<last name part>", so nothing outside the chosen
// entries is written and no archive path can escape the destination.
const EXTRACT_EXISTS = 17;
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;
const EXTRACT_SCRIPT = `a=$1; d=$2; ow=$3; shift 3
mkdir -p -- "$d" || exit 1
rel() {
  r=$1
  while :; do
    case $r in
      ./*) r=\${r#./} ;;
      ?*/) r=\${r%/} ;;
      *) break ;;
    esac
  done
  printf '%s' "$r"
}
if [ "$ow" != 1 ]; then
  for m in "$@"; do
    r=$(rel "$m"); b=\${r##*/}
    if [ -e "$d/$b" ] || [ -L "$d/$b" ]; then echo "$b" >&2; exit ${EXTRACT_EXISTS}; fi
  done
fi
t=$(mktemp -d "$d/.extract.XXXXXX") || exit 1
trap 'rm -rf -- "$t"' EXIT
zipx() {
  n=$#
  for m in "$@"; do
    e=$(printf '%s\n' "$m" | sed 's/[][\\\\*?]/\\\\&/g')
    set -- "$@" "$e" "$e/*"
  done
  shift "$n"
  unzip -o -q "$a" -d "$t" "$@"
}
case "$a" in
  *.zip|*.ZIP) zipx "$@" || exit $? ;;
  *.tar.gz|*.tgz|*.TGZ|*.TAR.GZ) tar -xzf "$a" -C "$t" -- "$@" || exit $? ;;
  *.tar.bz2|*.tbz2|*.TAR.BZ2) tar -xjf "$a" -C "$t" -- "$@" || exit $? ;;
  *.tar.xz|*.txz|*.TAR.XZ) tar -xJf "$a" -C "$t" -- "$@" || exit $? ;;
  *) tar -xf "$a" -C "$t" -- "$@" || exit $? ;;
esac
for m in "$@"; do
  r=$(rel "$m"); b=\${r##*/}; s="$t/$r"
  if [ ! -e "$s" ] && [ ! -L "$s" ]; then echo "$m: not found in the archive" >&2; exit 1; fi
  if [ -d "$s" ] && [ ! -L "$s" ] && [ -d "$d/$b" ] && [ ! -L "$d/$b" ]; then
    cp -a "$s/." "$d/$b/" || exit 1
  else
    rm -rf -- "$d/$b"; mv -- "$s" "$d/$b" || exit 1
  fi
done`;

/**
 * Extracts the chosen entries (files and folders) of an archive into `dest`,
 * each as `dest/<its name>`. Without `overwrite` it fails with EXISTS (and
 * names the clash in the message) when a target is already there.
 */
export async function extractArchiveEntries(
  t: ListTarget,
  archive: string,
  dest: string,
  chosen: string[],
  overwrite: boolean,
  signal?: AbortSignal,
  progress?: OpProgress,
): Promise<void> {
  if (chosen.length === 0) throw new HttpError(400, "Nothing to extract");
  if (chosen.length > EXTRACT_MAX_ENTRIES) {
    throw new HttpError(400, "Too many entries to extract at once");
  }
  progress?.setStage("preparing");
  const kind = kindOf(archive);
  const cached = await loadEntries(t, archive, kind, signal);
  const members = resolveMembers(cached.entries, chosen);
  let stopWatching: (() => void) | undefined;
  if (progress) {
    const roots = [...new Set(chosen)];
    progress.setTotal(
      cached.entries
        .filter((e) => e.type === "file")
        .filter((e) =>
          roots.some((r) => e.path === r || e.path.startsWith(`${r}/`)),
        )
        .reduce((sum, e) => sum + e.size, 0),
      true,
    );
    const usage = async () =>
      parseDuKb(
        (await probe(
          t,
          `du -sk -- "$1" 2>/dev/null; exit 0`,
          [dest],
          signal,
        )) ?? "",
      );
    const baseline = (await usage()) ?? 0;
    progress.setStage("extracting");
    stopWatching = watchProgress(progress, async () => {
      const now = await usage();
      return now === undefined ? undefined : Math.max(0, now - baseline);
    });
  }
  let result;
  try {
    result = await runCommand(
      t.client,
      execScriptCommand(t.runtime, t.containerId, EXTRACT_SCRIPT, [
        archive,
        dest,
        overwrite ? "1" : "0",
        ...members,
      ]),
      { signal, timeoutMs: EXTRACT_TIMEOUT_MS },
    );
  } finally {
    stopWatching?.();
  }
  progress?.setStage("finishing");
  if (result.code !== 0) throw errorFromResult(result);
}

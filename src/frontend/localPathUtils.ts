// Pure helpers of the local (this computer) pane: path parsing for Windows
// drives, UNC shares and POSIX roots, breadcrumbs, drive probing and the quick
// access shortcuts. No React, no network: the filesystem is passed in.

/** Virtual location that lists the drives (Windows only). */
export const THIS_PC = "::this-pc";

export type RootKind = "drive" | "unc" | "posix" | "relative";

export interface ParsedLocalPath {
  kind: RootKind;
  /** "C:\", "\\server\share\", "/" or "" for a relative path. */
  root: string;
  /** Names below the root. */
  parts: string[];
  /** Separator this path is written with. */
  sep: "\\" | "/";
}

const DRIVE_RE = /^([A-Za-z]):(?:[\\/]+(.*))?$/;
const UNC_RE = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/;

const split = (rest: string | undefined): string[] =>
  (rest ?? "").split(/[\\/]+/).filter(Boolean);

/** Splits a path into root and names; understands "C:\a", "\\srv\share\a", "/a". */
export function parseLocalPath(path: string): ParsedLocalPath {
  const drive = DRIVE_RE.exec(path);
  if (drive) {
    return {
      kind: "drive",
      root: `${drive[1]}:\\`,
      parts: split(drive[2]),
      sep: "\\",
    };
  }
  const unc = UNC_RE.exec(path);
  if (unc) {
    return {
      kind: "unc",
      root: `\\\\${unc[1]}\\${unc[2]}\\`,
      parts: split(unc[3]),
      sep: "\\",
    };
  }
  if (path.startsWith("/")) {
    return { kind: "posix", root: "/", parts: split(path), sep: "/" };
  }
  return {
    kind: "relative",
    root: "",
    parts: split(path),
    sep: path.includes("\\") ? "\\" : "/",
  };
}

function build(p: ParsedLocalPath, count: number): string {
  const names = p.parts.slice(0, count).join(p.sep);
  return p.root + names;
}

export interface Crumb {
  label: string;
  path: string;
}

/** Clickable segments of the path bar, root first. Empty for "This PC". */
export function breadcrumbParts(path: string): Crumb[] {
  if (path === THIS_PC || !path) return [];
  const p = parseLocalPath(path);
  const crumbs: Crumb[] = [];
  if (p.kind !== "relative") {
    crumbs.push({
      label:
        p.kind === "drive" ? p.root.slice(0, 2) : p.root.replace(/\\$/, ""),
      path: p.root,
    });
  }
  p.parts.forEach((name, i) => {
    crumbs.push({ label: name, path: build(p, i + 1) });
  });
  return crumbs;
}

/** Every location from the root down to `path`, for expanding a folder tree. */
export function localExpansionChain(path: string): string[] {
  return breadcrumbParts(path).map((c) => c.path);
}

export function isRootPath(path: string): boolean {
  if (path === THIS_PC) return true;
  const p = parseLocalPath(path);
  return p.kind !== "relative" && p.parts.length === 0;
}

/** Parent folder, or null at a root. */
export function parentOf(path: string): string | null {
  if (path === THIS_PC) return null;
  const p = parseLocalPath(path);
  if (p.parts.length === 0) return null;
  return build(p, p.parts.length - 1) || p.root || null;
}

/**
 * Where "up" goes: the parent, and from a drive root the drives list. UNC and
 * POSIX roots are the top.
 */
export function upTarget(path: string): string | null {
  const parent = parentOf(path);
  if (parent !== null) return parent;
  return parseLocalPath(path).kind === "drive" && path !== THIS_PC
    ? THIS_PC
    : null;
}

export function isWindowsPath(path: string): boolean {
  const kind = parseLocalPath(path).kind;
  return kind === "drive" || kind === "unc";
}

/** Drive letter ("C") of a path, or null. */
export function driveLetterOf(path: string): string | null {
  const m = DRIVE_RE.exec(path);
  return m ? m[1].toUpperCase() : null;
}

/** Root of a path ("C:\", "\\srv\share\", "/"), or null for a relative one. */
export function rootOf(path: string): string | null {
  const p = parseLocalPath(path);
  return p.kind === "relative" ? null : p.root;
}

/**
 * Canonical spelling of a location: upper-case drive letter, no repeated or
 * trailing separators (except the root's own).
 */
export function canonicalLocalPath(path: string): string {
  if (path === THIS_PC) return path;
  const p = parseLocalPath(path);
  if (p.kind === "relative") return path;
  if (p.kind === "drive") p.root = p.root.toUpperCase();
  return build(p, p.parts.length);
}

/**
 * What the user typed in the path bar, made into a path: "~" expands to the
 * home folder, "d" and "d:" become "D:\", slashes follow the platform,
 * surrounding quotes and trailing separators go.
 */
export function normalizeTypedPath(
  input: string,
  home: string,
  separator: string,
): string {
  let text = input
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .trim();
  if (!text) return "";
  if (text === "~" || /^~[\\/]/.test(text)) text = home + text.slice(1);
  const windows = separator === "\\" || isWindowsPath(text);
  if (windows) {
    if (/^[A-Za-z]:?$/.test(text)) return `${text[0].toUpperCase()}:\\`;
    if (text.toLowerCase() === "this pc") return THIS_PC;
    const unc = /^[\\/]{2}[^\\/]/.test(text);
    const flat = text.replace(/[\\/]+/g, "\\");
    return canonicalLocalPath(unc ? `\\${flat}` : flat);
  }
  return canonicalLocalPath(text);
}

// ---------------------------------------------------------------- drives ---

export const DRIVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export const driveRoot = (letter: string): string =>
  `${letter.toUpperCase()}:\\`;

/** Every drive root that could exist, in letter order. */
export const driveCandidates = (): string[] => DRIVE_LETTERS.map(driveRoot);

/**
 * Turns the paths a probe found (plus roots known from elsewhere, such as the
 * home drive or recent network shares) into unique roots: drives first in
 * letter order, then the rest in the order given.
 */
export function mergeRoots(
  found: readonly string[],
  extra: readonly string[] = [],
): string[] {
  const drives = new Set<string>();
  const others: string[] = [];
  for (const path of [...found, ...extra]) {
    const letter = driveLetterOf(path);
    if (letter) {
      drives.add(driveRoot(letter));
      continue;
    }
    const root = rootOf(path);
    if (root && !others.includes(root)) others.push(root);
  }
  return [...[...drives].sort(), ...others];
}

export type ExistsFn = (paths: string[]) => Promise<string[]>;

export interface DriveProbe {
  /** Drive roots, probed on first use and cached afterwards. */
  get(force?: boolean): Promise<string[]>;
  /** The cached answer, or null before the first probe finished. */
  peek(): string[] | null;
  clear(): void;
}

/**
 * Lazy, cached drive enumeration. The SDK has no "list drives" call, so each
 * letter is asked about with one batched `exists`. A failing or slow probe
 * (a disconnected network drive can stall) falls back to `known()` and is not
 * cached, so the next call tries again.
 */
export function createDriveProbe(
  exists: ExistsFn,
  options: {
    known?: () => string[];
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
  } = {},
): DriveProbe {
  const { known = () => [], ttlMs = 60_000, timeoutMs = 4_000 } = options;
  const now = options.now ?? Date.now;
  let cache: { at: number; roots: string[] } | null = null;
  let pending: Promise<string[]> | null = null;

  const run = async (): Promise<string[]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const found = await Promise.race([
        exists(driveCandidates()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("probe timeout")),
            timeoutMs,
          );
        }),
      ]);
      const roots = mergeRoots(found, known());
      cache = { at: now(), roots };
      return roots;
    } catch {
      return mergeRoots([], known());
    } finally {
      if (timer) clearTimeout(timer);
      pending = null;
    }
  };

  return {
    get(force = false) {
      if (!force && cache && now() - cache.at < ttlMs) {
        // Roots learned since the probe (a typed D:\) are folded in.
        return Promise.resolve(mergeRoots(cache.roots, known()));
      }
      pending ??= run();
      return pending;
    },
    peek: () => (cache ? mergeRoots(cache.roots, known()) : null),
    clear() {
      cache = null;
    },
  };
}

/** Most recent first, unique by root, capped. */
export function rememberRoot(
  list: readonly string[],
  path: string,
  max = 8,
): string[] {
  const raw = rootOf(path);
  if (!raw || raw === "/") return [...list];
  const root = canonicalLocalPath(raw);
  const key = root.toLowerCase();
  return [root, ...list.filter((r) => r.toLowerCase() !== key)].slice(0, max);
}

// ------------------------------------------------------------- shortcuts ---

export type ShortcutId =
  "home" | "desktop" | "documents" | "downloads" | "pictures";

/** Folders the backend resolved (and checked) with the operating system. */
export type KnownShortcutId = Exclude<ShortcutId, "home">;
export type KnownFolderPaths = Partial<Record<KnownShortcutId, string>>;

export interface LocalShortcut {
  id: ShortcutId;
  path: string;
}

/** Comparison key for "is this the path I asked about" (case-blind on Windows). */
export function pathKey(path: string): string {
  const p = parseLocalPath(path);
  const text = build(p, p.parts.length);
  return p.sep === "\\" ? text.toLowerCase() : text;
}

const FOLDERS: Array<[Exclude<ShortcutId, "home">, string]> = [
  ["desktop", "Desktop"],
  ["documents", "Documents"],
  ["downloads", "Downloads"],
  ["pictures", "Pictures"],
];

/**
 * Where each well-known folder may live under the home folder, best guess
 * first. OneDrive redirects Desktop, Documents and Pictures on Windows.
 */
export function shortcutCandidates(
  home: string,
  sep: string,
): Array<{ id: ShortcutId; candidates: string[] }> {
  const at = (...names: string[]) =>
    [home.replace(/[\\/]+$/, ""), ...names].join(sep);
  return FOLDERS.map(([id, name]) => ({
    id,
    candidates:
      id === "downloads"
        ? [at(name)]
        : [at(name), at("OneDrive", name), at(`OneDrive - Personal`, name)],
  }));
}

/**
 * Home plus the well-known folders that exist, using one `exists` call. The
 * SDK exposes only the home folder, so the others are looked for under it.
 */
export async function resolveShortcuts(
  home: string,
  sep: string,
  exists: ExistsFn,
  known: KnownFolderPaths = {},
): Promise<LocalShortcut[]> {
  const wanted = shortcutCandidates(home, sep).filter(
    (w) => w.id === "home" || !known[w.id as KnownShortcutId],
  );
  let found: string[] = [];
  try {
    found = await exists(wanted.flatMap((w) => w.candidates));
  } catch {
    /* only Home is offered */
  }
  const present = new Set(found.map(pathKey));
  const hits = new Map<ShortcutId, string>();
  for (const w of wanted) {
    const hit = w.candidates.find((c) => present.has(pathKey(c)));
    if (hit) hits.set(w.id, hit);
  }
  const out: LocalShortcut[] = [{ id: "home", path: home }];
  // Fixed order; the real folder wins over the guess.
  for (const [id] of FOLDERS) {
    const path = known[id] ?? hits.get(id);
    if (path) out.push({ id, path });
  }
  return out;
}

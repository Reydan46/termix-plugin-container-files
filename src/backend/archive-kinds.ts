/**
 * Which archive types the plugin knows, how a name maps to one, and which
 * programs inside the container each operation needs. Dependency free, so both
 * the browsing code (archive.ts) and the whole-archive extract (fs-ops.ts) can
 * use it.
 */

export type ArchiveKind =
  | "zip"
  | "tar"
  | "tgz"
  | "tbz"
  | "txz"
  | "tzst"
  | "7z"
  | "rar"
  | "gz"
  | "bz2"
  | "xz"
  | "zst";

/** Extensions read as zip: the formats are zip files with another name. */
export const ZIP_EXTENSIONS = [
  "zip",
  "jar",
  "war",
  "ear",
  "apk",
  "aar",
  "whl",
  "epub",
  "xpi",
  "vsix",
  "nupkg",
] as const;

export function archiveKind(path: string): ArchiveKind | null {
  const p = path.toLowerCase();
  const dot = p.lastIndexOf(".");
  const ext = dot >= 0 ? p.slice(dot + 1) : "";
  if ((ZIP_EXTENSIONS as readonly string[]).includes(ext)) return "zip";
  if (p.endsWith(".tar.gz") || ext === "tgz") return "tgz";
  if (p.endsWith(".tar.bz2") || ext === "tbz2" || ext === "tbz") return "tbz";
  if (p.endsWith(".tar.xz") || ext === "txz") return "txz";
  if (p.endsWith(".tar.zst") || ext === "tzst") return "tzst";
  if (ext === "tar") return "tar";
  if (ext === "7z") return "7z";
  if (ext === "rar") return "rar";
  if (ext === "gz") return "gz";
  if (ext === "bz2") return "bz2";
  if (ext === "xz") return "xz";
  if (ext === "zst") return "zst";
  return null;
}

/** One compressed file (not an archive of several): it can only be unpacked. */
export function isSingleFile(kind: ArchiveKind): boolean {
  return kind === "gz" || kind === "bz2" || kind === "xz" || kind === "zst";
}

/** Kinds whose member names are matched as patterns by the extracting tool. */
export function matchesPatterns(kind: ArchiveKind): boolean {
  return kind === "7z" || kind === "rar";
}

/** A program the container must have; any one of `any` will do. */
export interface ToolGroup {
  /** What the message calls it. */
  label: string;
  any: readonly string[];
}

export const SEVENZ_TOOLS = ["7zz", "7z", "7za", "7zr"] as const;
/** Only the full 7-Zip builds and unrar read rar files. */
export const RAR_TOOLS = ["7zz", "unrar", "7z"] as const;

const group = (label: string, ...any: string[]): ToolGroup => ({ label, any });

const SEVENZ = group("7z", ...SEVENZ_TOOLS);
const RAR = group("unrar", ...RAR_TOOLS);

/** Programs needed to list, open and selectively extract an archive. */
export function readTools(kind: ArchiveKind): ToolGroup[] {
  switch (kind) {
    case "zip":
      return [group("unzip", "unzip")];
    case "7z":
      return [SEVENZ];
    case "rar":
      return [RAR];
    case "tzst":
      return [group("tar", "tar"), group("zstd", "zstd")];
    case "gz":
      return [group("gzip", "gzip")];
    case "bz2":
      return [group("bzip2", "bzip2")];
    case "xz":
      return [group("xz", "xz")];
    case "zst":
      return [group("zstd", "zstd")];
    default:
      return [group("tar", "tar")];
  }
}

/** Programs for unpacking a whole archive: bsdtar can stand in for some. */
export function extractTools(kind: ArchiveKind): ToolGroup[] {
  switch (kind) {
    case "zip":
      return [group("unzip", "unzip", "bsdtar")];
    case "7z":
      return [group("7z", ...SEVENZ_TOOLS, "bsdtar")];
    case "rar":
      return [group("unrar", ...RAR_TOOLS, "bsdtar")];
    default:
      return readTools(kind);
  }
}

/** The first group none of whose programs is in `tools`, if any. */
export function missingGroup(
  tools: readonly string[],
  groups: ToolGroup[],
): ToolGroup | undefined {
  return groups.find((g) => !g.any.some((tool) => tools.includes(tool)));
}

/** The first of `candidates` present in `tools`. */
export function firstTool(
  tools: readonly string[],
  candidates: readonly string[],
): string | undefined {
  return candidates.find((tool) => tools.includes(tool));
}

// ---- shell fragments shared by the archive scripts ------------------------

/** Case pattern (`*.zip|*.jar|...`) for the zip family, on a lowercased name. */
export const ZIP_PATTERN = ZIP_EXTENSIONS.map((e) => `*.${e}`).join("|");

/** Sets `k` to the lowercased archive name in `$1`-style variable `$name`. */
export const lowerName = (name: string): string =>
  `k=$(printf '%s' "${name}" | tr '[:upper:]' '[:lower:]')`;

/** `pick a b c` prints the first program that exists and fails if none does. */
export const PICK_FN = `pick() { for s in "$@"; do if command -v "$s" >/dev/null 2>&1; then printf '%s' "$s"; return 0; fi; done; return 1; }`;

/** Looks a program up with pick and reports "<label>: not found" (exit 127). */
export const pickOrFail = (label: string, tools: readonly string[]): string =>
  `s=$(pick ${tools.join(" ")}) || { echo "${label}: not found" >&2; exit 127; }`;

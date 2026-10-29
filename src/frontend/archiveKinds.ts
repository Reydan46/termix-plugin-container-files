// Which archive types the file manager knows, decided from the file name.
// Mirrors the backend's archive-kinds.ts (a test keeps the two in step).

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

/** Zip files that carry another name. */
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

/** Case-insensitive; "a.tar.gz" is a tgz, a bare "a.gz" a single file. */
export function archiveKindOf(name: string): ArchiveKind | null {
  const p = name.toLowerCase();
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

/** One compressed file, not an archive of several: it can only be unpacked. */
export function isSingleFileKind(kind: ArchiveKind): boolean {
  return kind === "gz" || kind === "bz2" || kind === "xz" || kind === "zst";
}

/** The kind's extensions that open as an archive window, for path matching. */
export const BROWSABLE_EXTENSIONS = [
  ...ZIP_EXTENSIONS,
  "tar",
  "tgz",
  "tar.gz",
  "tbz2",
  "tbz",
  "tar.bz2",
  "txz",
  "tar.xz",
  "tzst",
  "tar.zst",
  "7z",
  "rar",
] as const;

const SEVENZ = ["7zz", "7z", "7za", "7zr"];
const RAR = ["7zz", "unrar", "7z"];

interface Group {
  label: string;
  any: string[];
}

const group = (label: string, ...any: string[]): Group => ({ label, any });

/** Programs an operation needs; any one of each group's `any` will do. */
function groups(kind: ArchiveKind, extract: boolean): Group[] {
  switch (kind) {
    case "zip":
      return [group("unzip", "unzip", ...(extract ? ["bsdtar"] : []))];
    case "7z":
      return [group("7z", ...SEVENZ, ...(extract ? ["bsdtar"] : []))];
    case "rar":
      return [group("unrar", ...RAR, ...(extract ? ["bsdtar"] : []))];
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

/**
 * The container program to check for opening (`extract` false) or unpacking an
 * archive: the one that is installed, or the name of the first missing one
 * (what the message should say). "tar" for a name that is no archive.
 */
export function archiveToolFor(
  name: string,
  tools: readonly string[],
  extract = false,
): string {
  const kind = archiveKindOf(name);
  if (!kind) return "tar";
  const all = groups(kind, extract);
  for (const g of all) {
    if (!g.any.some((tool) => tools.includes(tool))) return g.label;
  }
  return all[0].any.find((tool) => tools.includes(tool)) ?? all[0].label;
}

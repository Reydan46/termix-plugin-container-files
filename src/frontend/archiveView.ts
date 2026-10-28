// Pure helpers behind the archive window: ordering, type labels and totals.

export interface ViewEntry {
  name: string;
  type: "file" | "directory" | "link" | "symlink" | "other";
  size: number;
  mtime: number;
}

export type SortKey = "name" | "size" | "modified" | "type";
export type SortDir = "asc" | "desc";

export const isDirEntry = (e: Pick<ViewEntry, "type">): boolean =>
  e.type === "directory";

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 || i === name.length - 1 ? "" : name.slice(i + 1).toLowerCase();
}

/** Sort key of the Type column: folders, then links, then by extension. */
export function typeSortKey(e: ViewEntry): string {
  if (isDirEntry(e)) return "\u0000";
  if (e.type === "link" || e.type === "symlink") return "\u0001";
  return extensionOf(e.name);
}

/** Folders always come first; ties fall back to the name. */
export function sortEntries<T extends ViewEntry>(
  entries: readonly T[],
  key: SortKey,
  dir: SortDir,
): T[] {
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: T, b: T) =>
    a.name.localeCompare(b.name, undefined, { numeric: true });
  return [...entries].sort((a, b) => {
    const folders = Number(isDirEntry(b)) - Number(isDirEntry(a));
    if (folders) return folders;
    let r = 0;
    if (key === "size") r = a.size - b.size;
    else if (key === "modified") r = a.mtime - b.mtime;
    else if (key === "type") r = typeSortKey(a).localeCompare(typeSortKey(b));
    if (r === 0) r = byName(a, b);
    return r * sign;
  });
}

export interface ArchiveSummary {
  items: number;
  selected: number;
  /** Bytes of the files in the folder (folders have no size of their own). */
  totalSize: number;
  selectedSize: number;
}

export function summarize(
  entries: readonly ViewEntry[],
  selected: ReadonlySet<string>,
): ArchiveSummary {
  let totalSize = 0;
  let selectedSize = 0;
  let sel = 0;
  for (const e of entries) {
    const size = isDirEntry(e) ? 0 : e.size;
    totalSize += size;
    if (selected.has(e.name)) {
      sel++;
      selectedSize += size;
    }
  }
  return { items: entries.length, selected: sel, totalSize, selectedSize };
}

/** The inner folder as breadcrumb segments, each with its full inner path. */
export function innerCrumbs(dir: string): { name: string; path: string }[] {
  const parts = dir.split("/").filter(Boolean);
  return parts.map((name, i) => ({
    name,
    path: `/${parts.slice(0, i + 1).join("/")}`,
  }));
}

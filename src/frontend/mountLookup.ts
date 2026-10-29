// Pure helpers: which container paths are mount points.

export interface MountInfo {
  type: "bind" | "volume" | "tmpfs";
  source: string;
  destination: string;
  readOnly: boolean;
  name?: string;
}

export interface MountMark {
  title: string;
  readOnly: boolean;
  /** Where the mount comes from: a host path, a volume name or "tmpfs". */
  target: string;
  /** Short access label: "RW" or "RO". */
  label: string;
}

/** "/a/b/" -> "/a/b"; the root stays "/". */
function trimPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

/** Maps a mount destination to the mount. Only an exact path is a mount. */
export function indexMounts(mounts: MountInfo[]): Map<string, MountInfo> {
  const map = new Map<string, MountInfo>();
  for (const mount of mounts) map.set(trimPath(mount.destination), mount);
  return map;
}

/** The mount whose destination is exactly `path`; folders that merely contain mounts give null. */
export function mountAt(
  index: Map<string, MountInfo>,
  path: string,
): MountInfo | null {
  return index.get(trimPath(path)) ?? null;
}

/** Label for the badge tooltip; `rw` and `ro` are the translated access words. */
export function mountTitle(
  mount: MountInfo,
  label: (type: MountInfo["type"]) => string,
  access: { rw: string; ro: string },
): string {
  const where = mount.source || mount.name || "";
  const head = `${label(mount.type)}${where ? ` — ${where}` : ""}`;
  return `${head} (${mount.readOnly ? access.ro : access.rw})`;
}

/** What a mount points to: a bind's host path, a volume's name, "tmpfs". */
export function mountTarget(mount: MountInfo): string {
  if (mount.type === "tmpfs") return "tmpfs";
  if (mount.type === "volume") return mount.name || mount.source;
  return mount.source || mount.name || "";
}

/**
 * Where the RW / RO letters sit inside a 24-unit icon viewBox. The lucide
 * folder body spans x 2..22 and y 6..20 (centre 12,13); the letters are
 * centred on it, condensed with textLength so two glyphs fit the body.
 */
export const MOUNT_LETTERS = {
  viewBox: 24,
  x: 12,
  /** Baseline: cap height is about 0.72 * fontSize, so the caps centre on y 13. */
  y: 17.1,
  fontSize: 11.5,
  textLength: 17,
} as const;

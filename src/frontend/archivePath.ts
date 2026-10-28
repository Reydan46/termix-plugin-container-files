// Virtual paths for browsing inside an archive: "<archive path>!<inner path>",
// e.g. "/data/a.tgz!/sub". The root of an archive is "/data/a.tgz!".

const ARCHIVE_NAME = /\.(?:tar|tgz|tar\.gz|tbz2|tar\.bz2|txz|tar\.xz|zip)$/i;
const VIRTUAL =
  /^(.+?\.(?:tar|tgz|tar\.gz|tbz2|tar\.bz2|txz|tar\.xz|zip))!(\/.*)?$/i;

/** True for file names the plugin can browse as an archive. */
export function isBrowsableArchive(name: string): boolean {
  return ARCHIVE_NAME.test(name);
}

export function isZipName(name: string): boolean {
  return /\.zip$/i.test(name);
}

export interface VirtualPath {
  /** Path of the archive file in the container. */
  archive: string;
  /** Absolute path inside the archive ("/" for its root). */
  inner: string;
}

export function parseVirtualPath(path: string): VirtualPath | null {
  const m = VIRTUAL.exec(path);
  if (!m) return null;
  const inner = (m[2] ?? "/").replace(/\/+$/, "") || "/";
  return { archive: m[1], inner };
}

export function isVirtualPath(path: string): boolean {
  return VIRTUAL.test(path);
}

export function virtualPath(archive: string, inner = "/"): string {
  return `${archive}!${inner.replace(/\/+$/, "")}`;
}

function dirname(path: string): string {
  if (path === "/") return "/";
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/** Parent folder; leaving an archive's root returns to the folder holding it. */
export function parentPath(path: string): string {
  const v = parseVirtualPath(path);
  if (!v) return dirname(path);
  if (v.inner === "/") return dirname(v.archive);
  return virtualPath(v.archive, dirname(v.inner));
}

/** The folder shown behind a path, for breadcrumbs and "go to the real dir". */
export function containingDirectory(path: string): string {
  const v = parseVirtualPath(path);
  return v ? dirname(v.archive) : path;
}

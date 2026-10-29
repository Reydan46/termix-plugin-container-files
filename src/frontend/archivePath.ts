// Virtual paths for browsing inside an archive: "<archive path>!<inner path>",
// e.g. "/data/a.tgz!/sub". The root of an archive is "/data/a.tgz!".

import {
  archiveKindOf,
  BROWSABLE_EXTENSIONS,
  isSingleFileKind,
} from "./archiveKinds";

const EXTENSIONS = BROWSABLE_EXTENSIONS.map((e) => e.replace(".", "\\.")).join(
  "|",
);
const VIRTUAL = new RegExp(`^(.+?\\.(?:${EXTENSIONS}))!(\\/.*)?$`, "i");

/** True for file names the plugin can browse as an archive. */
export function isBrowsableArchive(name: string): boolean {
  const kind = archiveKindOf(name);
  return kind !== null && !isSingleFileKind(kind);
}

/** True for archives that can be unpacked: browsable ones and single .gz/.bz2/.xz/.zst files. */
export function isExtractableArchive(name: string): boolean {
  return archiveKindOf(name) !== null;
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

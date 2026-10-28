export function parentDir(path: string): string {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/** The folder a picker starts in for a typed path (falls back to "/"). */
export function startDir(path: string, isFolder: boolean): string {
  const p = path.trim();
  if (!p.startsWith("/") || p.includes("\0")) return "/";
  const clean = p.replace(/\/+$/, "") || "/";
  return isFolder ? clean : parentDir(clean);
}

/** Whether a typed extract destination can be sent to the backend. */
export function extractDestValid(dest: string): boolean {
  const d = dest.trim();
  return d.startsWith("/") && !d.includes("\0") && !d.includes("!");
}

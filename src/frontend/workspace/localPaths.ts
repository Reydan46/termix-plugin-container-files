// Path helpers for the user's own computer (Windows or POSIX separators).

export function localBaseName(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  return clean.slice(
    Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1,
  );
}

/** Paths of a `local_files` drag payload (what the local pane puts on text/plain). */
export function parseLocalFiles(raw: string): string[] {
  try {
    const data = JSON.parse(raw) as { type?: string; paths?: unknown };
    if (data?.type !== "local_files" || !Array.isArray(data.paths)) return [];
    return data.paths.filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
  } catch {
    return [];
  }
}

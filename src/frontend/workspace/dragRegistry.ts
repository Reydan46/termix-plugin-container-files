// Which pane an in-app file drag started in. The vendored grid keeps its drag
// state per instance and puts only paths on the DataTransfer, so the
// workspace remembers the source pane itself.

export interface ActiveDrag {
  paneId: string;
  /** null when the drag started in the local (this computer) pane. */
  containerId: string | null;
  paths: string[];
}

let active: ActiveDrag | null = null;

export function setActiveDrag(drag: ActiveDrag): void {
  active = drag;
}

export function getActiveDrag(): ActiveDrag | null {
  return active;
}

export function clearActiveDrag(): void {
  active = null;
}

/** Paths from the grid's `text/plain` internal_files payload. */
export function parseInternalFiles(raw: string): string[] {
  try {
    const data = JSON.parse(raw) as { type?: string; files?: unknown };
    if (data?.type !== "internal_files" || !Array.isArray(data.files))
      return [];
    return data.files.filter((f): f is string => typeof f === "string");
  } catch {
    return [];
  }
}

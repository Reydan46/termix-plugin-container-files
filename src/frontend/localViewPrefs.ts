/**
 * View settings of the local pane (list or grid, comfortable or compact) and
 * the row and cell sizes of both views. The sizes are the container grid's,
 * so the two panes look alike.
 */

export type LocalViewMode = "grid" | "list";
export type LocalDensity = "comfortable" | "compact";

export interface LocalViewPrefs {
  viewMode: LocalViewMode;
  density: LocalDensity;
}

export const DEFAULT_VIEW_PREFS: LocalViewPrefs = {
  viewMode: "list",
  density: "comfortable",
};

/** Reads the stored JSON; anything unusable falls back field by field. */
export function parseViewPrefs(raw: string | null | undefined): LocalViewPrefs {
  if (!raw) return { ...DEFAULT_VIEW_PREFS };
  try {
    const value: unknown = JSON.parse(raw);
    const obj =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    return {
      viewMode:
        obj.viewMode === "grid" || obj.viewMode === "list"
          ? obj.viewMode
          : DEFAULT_VIEW_PREFS.viewMode,
      density:
        obj.density === "compact" || obj.density === "comfortable"
          ? obj.density
          : DEFAULT_VIEW_PREFS.density,
    };
  } catch {
    return { ...DEFAULT_VIEW_PREFS };
  }
}

export function serializeViewPrefs(prefs: LocalViewPrefs): string {
  return JSON.stringify({ viewMode: prefs.viewMode, density: prefs.density });
}

export interface ViewMetrics {
  listRowHeight: number;
  gridRowHeight: number;
  contentPad: number;
  gridGap: number;
  gridCell: number;
}

export function viewMetrics(density: LocalDensity): ViewMetrics {
  const compact = density === "compact";
  return {
    listRowHeight: compact ? 29 : 41,
    gridRowHeight: compact ? 84 : 112,
    contentPad: compact ? 8 : 16,
    gridGap: compact ? 8 : 16,
    gridCell: compact ? 76 : 112,
  };
}

/** Number of grid columns that fit the given inner width (2 to 10). */
export function gridColumns(width: number, density: LocalDensity): number {
  const m = viewMetrics(density);
  const usable = width - m.contentPad * 2;
  const n = Math.floor((usable + m.gridGap) / m.gridCell);
  return Math.max(2, Math.min(10, Number.isFinite(n) ? n : 2));
}

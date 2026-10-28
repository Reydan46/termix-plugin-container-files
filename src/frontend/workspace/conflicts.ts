// Pure conflict planning for cross-pane transfers. The backend takes
// `renames` (source top-level name -> new name) and `skip` (names to leave out).

export type Decision = "replace" | "skip" | "rename";

export function baseName(path: string): string {
  const clean = path.replace(/\/+$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1);
}

export function parentPath(path: string): string {
  const clean = path.replace(/\/+$/, "");
  const i = clean.lastIndexOf("/");
  return i <= 0 ? "/" : clean.slice(0, i);
}

/** "a.txt" -> "a (2).txt", "dir" -> "dir (2)"; first free number from 2. */
export function uniqueName(
  name: string,
  isTaken: (candidate: string) => boolean,
  isDirectory = false,
): string {
  const match = isDirectory
    ? null
    : /^(.+?)((?:\.tar)?\.[A-Za-z0-9_-]{1,10})$/.exec(name);
  const base = match ? match[1] : name;
  const ext = match ? match[2] : "";
  let candidate = `${base} (2)${ext}`;
  for (let n = 3; isTaken(candidate); n++) candidate = `${base} (${n})${ext}`;
  return candidate;
}

/** The name "Keep both" gives an item, as planConflicts does when nothing else is taken. */
export function keepBothName(item: SourceItem): string {
  return uniqueName(item.name, () => false, item.isDirectory);
}

export interface SourceItem {
  name: string;
  isDirectory: boolean;
}

/** Names of the sources that already exist at the target. */
export function findConflicts(
  sources: SourceItem[],
  existing: Iterable<string>,
): SourceItem[] {
  const have = new Set(existing);
  return sources.filter((s) => have.has(s.name));
}

export interface ConflictPlan {
  renames: Record<string, string>;
  skip: string[];
  /** Number of items that will really be transferred. */
  count: number;
}

/**
 * `decisions` is keyed by source name; a missing decision means "replace".
 * `selfNames` are sources whose target is the very same path (same container,
 * same folder): never replaced, a move skips them, a copy keeps both.
 */
export function planConflicts(
  sources: SourceItem[],
  existing: Iterable<string>,
  decisions: Record<string, Decision>,
  options: { selfNames?: ReadonlySet<string>; move?: boolean } = {},
): ConflictPlan {
  const have = new Set(existing);
  const taken = new Set<string>([...have, ...sources.map((s) => s.name)]);
  const renames: Record<string, string> = {};
  const skip: string[] = [];
  for (const source of sources) {
    const isSelf = options.selfNames?.has(source.name) ?? false;
    const conflict = have.has(source.name);
    if (!conflict && !isSelf) continue;
    let decision: Decision = isSelf
      ? options.move
        ? "skip"
        : "rename"
      : (decisions[source.name] ?? "replace");
    if (isSelf && decision === "rename" && decisions[source.name] === "skip")
      decision = "skip";
    if (decision === "skip") {
      skip.push(source.name);
    } else if (decision === "rename") {
      const name = uniqueName(
        source.name,
        (c) => taken.has(c),
        source.isDirectory,
      );
      taken.add(name);
      renames[source.name] = name;
    }
  }
  return { renames, skip, count: sources.length - skip.length };
}

/**
 * The name "Keep both" really gives each asked item: the very same plan the
 * transfer later runs, with every asked item set to rename (existing names,
 * the other sources and earlier renames all count as taken).
 */
export function keepBothNames(
  sources: SourceItem[],
  existing: Iterable<string>,
  asking: SourceItem[],
  options: { selfNames?: ReadonlySet<string>; move?: boolean } = {},
): Record<string, string> {
  const decisions: Record<string, Decision> = {};
  for (const item of asking) decisions[item.name] = "rename";
  const { renames } = planConflicts(sources, existing, decisions, options);
  const out: Record<string, string> = {};
  for (const item of asking)
    out[item.name] = renames[item.name] ?? keepBothName(item);
  return out;
}

export interface ResolveState {
  /** Items still waiting for a choice. */
  pending: SourceItem[];
  decisions: Record<string, Decision>;
}

/** Applies one choice to one pending item. */
export function resolveOne(
  state: ResolveState,
  name: string,
  decision: Decision,
): ResolveState {
  if (!state.pending.some((i) => i.name === name)) return state;
  return {
    pending: state.pending.filter((i) => i.name !== name),
    decisions: { ...state.decisions, [name]: decision },
  };
}

/** Applies one choice to every pending item. */
export function resolveAll(
  state: ResolveState,
  decision: Decision,
): ResolveState {
  const decisions = { ...state.decisions };
  for (const i of state.pending) decisions[i.name] = decision;
  return { pending: [], decisions };
}

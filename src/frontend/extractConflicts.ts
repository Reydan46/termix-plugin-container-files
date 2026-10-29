import {
  findConflicts,
  keepBothNames,
  planConflicts,
  type Decision,
  type SourceItem,
} from "./workspace/conflicts";
import type { ExtractChoices } from "./containerFsApi";

/**
 * Pure decisions of an extraction into a folder that may already hold some of
 * the names it creates. The conflict window (workspace/ConflictWindow) is the
 * same one the transfers use: replace, skip or keep both, per item or for all.
 */

/** The names the window asks about, and what "keep both" will call each. */
export function extractQuestions(
  items: SourceItem[],
  existing: Iterable<string>,
): { asking: SourceItem[]; renamed: Record<string, string> } {
  const have = new Set(existing);
  const asking = findConflicts(items, have);
  return {
    asking,
    renamed: asking.length > 0 ? keepBothNames(items, have, asking) : {},
  };
}

export interface ExtractRun {
  /** Number of items that will really be extracted. */
  count: number;
  /**
   * Names to leave out and names to change; null when every conflict is a
   * replace (the extraction then simply overwrites, as it always did).
   */
  choices: ExtractChoices | null;
}

/** What to run after the window: `decisions` is keyed by item name. */
export function planExtraction(
  items: SourceItem[],
  existing: Iterable<string>,
  decisions: Record<string, Decision>,
): ExtractRun {
  const have = new Set(existing);
  const plan = planConflicts(items, have, decisions);
  const skipped = new Set(plan.skip);
  const replace = items
    .map((i) => i.name)
    .filter((n) => have.has(n) && !skipped.has(n) && !(n in plan.renames));
  const choices =
    plan.skip.length > 0 || Object.keys(plan.renames).length > 0
      ? { skip: plan.skip, renames: plan.renames, replace }
      : null;
  return { count: plan.count, choices };
}

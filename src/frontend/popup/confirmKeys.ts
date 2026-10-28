// Pure key rules of the confirm card, kept apart from the DOM for testing.

export type ConfirmKeyAction = "confirm" | "cancel" | "native" | "block" | null;

/**
 * What a keydown does on the topmost confirm card.
 * - Escape cancels.
 * - Enter confirms when the confirm button, or nothing (body), has focus; on
 *   the cancel button it is left to the browser (a click on Cancel); anywhere
 *   else it is swallowed so a terminal behind the card never sees it.
 * - Only the topmost card reacts at all.
 */
export function confirmKeyAction<T>(input: {
  key: string;
  topmost: boolean;
  active: T | null;
  confirmEl: T | null;
  cancelEl: T | null;
  body: T | null;
}): ConfirmKeyAction {
  const { key, topmost, active, confirmEl, cancelEl, body } = input;
  if (key !== "Enter" && key !== "Escape") return null;
  if (!topmost) return null;
  if (key === "Escape") return "cancel";
  if (active === null || active === body || active === confirmEl)
    return "confirm";
  if (active === cancelEl) return "native";
  return "block";
}

/** Adds a card to the stack and tells whether it is the topmost one. */
export class ConfirmStack {
  private ids: number[] = [];
  private next = 0;
  push(): number {
    const id = ++this.next;
    this.ids.push(id);
    return id;
  }
  remove(id: number): void {
    this.ids = this.ids.filter((i) => i !== id);
  }
  isTop(id: number): boolean {
    return this.ids[this.ids.length - 1] === id;
  }
}

// Pure key rules of the confirm card, kept apart from the DOM for testing.

export type ConfirmKeyAction =
  "confirm" | "cancel" | "refocus" | "swallow" | null;

/**
 * What a keydown does while a confirm card is up. The card is modal, so the
 * topmost one owns every key: nothing may reach the file pane behind it.
 * - Escape cancels.
 * - Enter confirms when the confirm button, or nothing (body), has focus, and
 *   cancels on the cancel button. Held down (auto-repeat) it does nothing, so
 *   the Enter that opened the card cannot also answer it. With focus anywhere
 *   else (a terminal or file pane behind the card) it only puts the focus back
 *   on the confirm button.
 * - Every other key is swallowed ("swallow": stop it reaching the page, leave
 *   its default alone, so Tab and copy still work).
 * - A card that is not the topmost one ignores keys (null).
 */
export function confirmKeyAction<T>(input: {
  key: string;
  topmost: boolean;
  repeat?: boolean;
  active: T | null;
  confirmEl: T | null;
  cancelEl: T | null;
  body: T | null;
}): ConfirmKeyAction {
  const { key, topmost, repeat, active, confirmEl, cancelEl, body } = input;
  if (!topmost) return null;
  if (key === "Escape") return "cancel";
  if (key !== "Enter") return "swallow";
  if (repeat) return "swallow";
  if (active === null || active === body || active === confirmEl)
    return "confirm";
  if (active === cancelEl) return "cancel";
  return "refocus";
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

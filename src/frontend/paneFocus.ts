// Which file pane owns the keyboard. The vendored grid listens for shortcuts on
// `document`, so with several panes open every one of them would react to a
// key (Delete asked for confirmation in all of them). A pane marks its root
// with `data-fm-pane`; the last pane the user pressed or focused is the only
// one whose grid handles keys.

export const PANE_ATTR = "data-fm-pane";
const PANE_SELECTOR = `[${PANE_ATTR}]`;

let active: Element | null = null;

/**
 * The active pane after an interaction. A press inside a pane selects it; a
 * press inside a confirm card keeps the current one (the card belongs to the
 * pane that opened it); a press anywhere else (another pane kind, a terminal)
 * leaves no active pane.
 */
export function nextActivePane<T>(
  current: T | null,
  pressedPane: T | null,
  inDialog: boolean,
): T | null {
  if (pressedPane) return pressedPane;
  return inDialog ? current : null;
}

/** True when `pane` may handle keys. A grid outside any pane always may. */
export function ownsKeys<T>(pane: T | null, activePane: T | null): boolean {
  return pane === null || pane === activePane;
}

export function isActivePane(pane: Element | null): boolean {
  // Before any press, or after the active pane unmounted, the first pane in
  // the document owns the keys.
  const current = active?.isConnected
    ? active
    : document.querySelector(PANE_SELECTOR);
  return ownsKeys(pane, current);
}

export function paneOf(node: Element | null): Element | null {
  return node?.closest(PANE_SELECTOR) ?? null;
}

function track(event: Event) {
  const target = event.target instanceof Element ? event.target : null;
  active = nextActivePane(
    active,
    paneOf(target),
    !!target?.closest('[role="alertdialog"]'),
  );
}

if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", track, true);
  document.addEventListener("focusin", track, true);
}

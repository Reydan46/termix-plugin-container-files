import React from "react";
import {
  dialogKeyAction,
  nextButtonIndex,
  orientationOf,
  shouldHandleArrow,
  type KeyInfo,
  type KeyTarget,
} from "./dialogKeys";
import { DIALOG_BUTTONS_CLASS, ensureDialogStyles } from "./dialogStyles";

/** Marks the button Enter activates in a dialog (the primary choice). */
export const DIALOG_DEFAULT_ATTR = "data-dialog-default";
/** Props for that button. */
export const DIALOG_DEFAULT = { [DIALOG_DEFAULT_ATTR]: "" } as const;

const EDITOR_SELECTOR = ".cm-editor, [data-code-editor]";

export function describeTarget(el: Element | null): KeyTarget {
  if (!el) return { tag: "" };
  const html = el as HTMLElement;
  const role = el.getAttribute("role") ?? undefined;
  const multiline = el.getAttribute("aria-multiline") === "true";
  return {
    tag: el.tagName,
    inputType: el instanceof HTMLInputElement ? el.type : undefined,
    role: multiline ? "textbox-multiline" : role,
    isContentEditable: html.isContentEditable === true,
    inForm: el.closest("form") !== null,
    inEditor: el.closest(EDITOR_SELECTOR) !== null,
  };
}

/** The enabled default button inside `root`, if any. */
export function findDefaultButton(
  root: ParentNode | null,
): HTMLButtonElement | null {
  const el = root?.querySelector<HTMLButtonElement>(
    `button[${DIALOG_DEFAULT_ATTR}]`,
  );
  return el && !el.disabled ? el : null;
}

/**
 * Moves focus to the next enabled button of the dialog's button row on an
 * arrow key, wrapping around. The row is the one holding the focused element;
 * with focus on the dialog itself (or nothing) it is the last row. Returns
 * whether it moved focus. Shared by the popup windows and the confirm card.
 */
export function moveDialogButtonFocus(
  root: HTMLElement | null,
  e: KeyInfo,
  active: Element | null,
  topmost: boolean,
): boolean {
  if (!root || !shouldHandleArrow(e, describeTarget(active), topmost))
    return false;
  const selector = `.${DIALOG_BUTTONS_CLASS}`;
  let row: HTMLElement | null = null;
  if (active && active !== root && active !== document.body) {
    row = active.closest<HTMLElement>(selector);
    if (!row || !root.contains(row)) return false;
  } else {
    const rows = root.querySelectorAll<HTMLElement>(selector);
    row = rows.length > 0 ? rows[rows.length - 1] : null;
  }
  if (!row) return false;
  const buttons = [...row.querySelectorAll<HTMLButtonElement>("button")].filter(
    (b) => !b.disabled,
  );
  const next = nextButtonIndex(
    active ? buttons.indexOf(active as HTMLButtonElement) : -1,
    buttons.length,
    e.key,
    orientationOf(buttons.map((b) => b.getBoundingClientRect())),
  );
  if (next === null) return false;
  buttons[next].focus({ preventScroll: true });
  return true;
}

/**
 * Keyboard handling of a dialog: Enter clicks its default button (see
 * `shouldHandleEnter` for when it does not), Escape cancels. Attach the
 * returned handler to the dialog's element; only `topmost` dialogs react.
 */
export function useDialogKeys(options: {
  rootRef: React.RefObject<HTMLElement | null>;
  topmost: boolean;
  onCancel: () => void;
  enabled?: boolean;
}): (e: React.KeyboardEvent) => void {
  const latest = React.useRef(options);
  latest.current = options;
  React.useEffect(ensureDialogStyles, []);
  return React.useCallback((e: React.KeyboardEvent) => {
    const { rootRef, topmost, onCancel, enabled } = latest.current;
    if (enabled === false) return;
    const info: KeyInfo = {
      key: e.key,
      isComposing: e.nativeEvent.isComposing,
      keyCode: e.keyCode,
      defaultPrevented: e.defaultPrevented,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
    };
    if (
      moveDialogButtonFocus(
        rootRef.current,
        info,
        document.activeElement,
        topmost,
      )
    ) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const action = dialogKeyAction(
      info,
      describeTarget(e.target instanceof Element ? e.target : null),
      topmost,
    );
    if (action === null) return;
    if (action === "cancel") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    const button = findDefaultButton(rootRef.current);
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    button.click();
  }, []);
}

/**
 * On open, puts focus on the default button (or the dialog itself) unless a
 * field already took it, so Enter and Escape reach the dialog.
 */
export function focusDialogDefault(root: HTMLElement | null): void {
  if (!root) return;
  const active = document.activeElement;
  if (active && active !== document.body && root.contains(active)) return;
  (findDefaultButton(root) ?? root).focus({ preventScroll: true });
}

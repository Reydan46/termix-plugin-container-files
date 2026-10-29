// Keeps the file panes' shortcuts out of dialogs. The vendored grid and the
// local pane listen for keys on `document`, so a key pressed in a dialog (or a
// popup window, or while a confirm card is up) bubbles there and, for example,
// Enter opens the file that happens to be selected behind it.

/** Elements whose keys belong to a dialog, a floating window or a menu. */
export const DIALOG_KEY_SCOPE =
  '.window-container, [role="dialog"], [role="alertdialog"], [role="menu"]';

/** The modal confirm card (see useConfirm). */
export const CONFIRM_SELECTOR = '[role="alertdialog"]';

/**
 * Whether the file panes must leave this key alone: a modal confirm is open
 * anywhere (it owns every key until it closes), or the key comes from inside a
 * dialog, floating window or menu.
 */
export function fileKeysBlocked(scope: {
  confirmOpen: boolean;
  fromDialog: boolean;
}): boolean {
  return scope.confirmOpen || scope.fromDialog;
}

/** `fileKeysBlocked` for a real keydown. */
export function dialogOwnsKey(event: { target: EventTarget | null }): boolean {
  if (typeof document === "undefined") return false;
  const target = event.target instanceof Element ? event.target : null;
  return fileKeysBlocked({
    confirmOpen: document.querySelector(CONFIRM_SELECTOR) !== null,
    fromDialog: target?.closest(DIALOG_KEY_SCOPE) != null,
  });
}

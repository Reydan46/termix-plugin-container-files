/** Class on a dialog's row of buttons; arrow keys move among its buttons. */
export const DIALOG_BUTTONS_CLASS = "tfm-dialog-buttons";

const STYLE_ID = "tfm-dialog-buttons-style";

// The focused button is the one Enter activates: a two-tone ring (readable on
// light and dark backgrounds), a tint over its own fill and bold text.
export const DIALOG_BUTTONS_CSS = `
.${DIALOG_BUTTONS_CLASS} button:focus,
.${DIALOG_BUTTONS_CLASS} button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px #ffffff, 0 0 0 4px #2563eb, 0 0 0 5px rgba(0, 0, 0, 0.45);
  background-image: linear-gradient(rgba(59, 130, 246, 0.28), rgba(59, 130, 246, 0.28));
  font-weight: 600;
  position: relative;
  z-index: 1;
}
`;

/** Adds the shared highlight rules to the page once. */
export function ensureDialogStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID))
    return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = DIALOG_BUTTONS_CSS;
  document.head.appendChild(style);
}

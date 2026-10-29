import { describe, expect, it } from "vitest";
import {
  DIALOG_KEY_SCOPE,
  dialogOwnsKey,
  fileKeysBlocked,
} from "../../src/frontend/popup/keyGuard";

describe("fileKeysBlocked", () => {
  it("lets the file panes have their keys when no dialog is involved", () => {
    expect(fileKeysBlocked({ confirmOpen: false, fromDialog: false })).toBe(
      false,
    );
  });
  it("blocks a key from inside a dialog, window or menu", () => {
    expect(fileKeysBlocked({ confirmOpen: false, fromDialog: true })).toBe(
      true,
    );
  });
  it("blocks every key while a confirm is open, wherever it comes from", () => {
    expect(fileKeysBlocked({ confirmOpen: true, fromDialog: false })).toBe(
      true,
    );
    expect(fileKeysBlocked({ confirmOpen: true, fromDialog: true })).toBe(true);
  });
});

describe("dialogOwnsKey", () => {
  it("does not block without a document (tests, SSR)", () => {
    expect(dialogOwnsKey({ target: null })).toBe(false);
  });
  it("covers popup windows, dialogs, alert dialogs and menus", () => {
    for (const part of [
      ".window-container",
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[role="menu"]',
    ])
      expect(DIALOG_KEY_SCOPE).toContain(part);
  });
});

import React from "react";
import type { Box } from "./popupGeometry";

/** What a popup body can ask of the frame it is rendered in. */
export interface PopupWindowInfo {
  windowId: string;
  /** The container this popup belongs to (shown in the title bar). */
  label: string;
  close: () => void;
  /** The frame's current rectangle in client coordinates, if mounted. */
  getRect: () => Box | null;
}

export const PopupWindowContext = React.createContext<PopupWindowInfo | null>(
  null,
);

/** The frame this component is rendered in; throws outside a popup. */
export function usePopupWindow(): PopupWindowInfo {
  const info = React.useContext(PopupWindowContext);
  if (!info) throw new Error("usePopupWindow must be used inside a popup");
  return info;
}

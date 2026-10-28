import React from "react";
import {
  useWindowManager,
  type WindowInstance,
} from "../vendor/file-manager/components/WindowManager";
import { PopupWindowContext } from "./PopupContext";
import { PopupFrame } from "./PopupFrame";
import { boxOf, chooseAnchor, POPUP_WIDTH } from "./popupGeometry";
import { lastPointer } from "./pointerTracker";

export interface PopupOptions {
  /** What the window is ("Archive"); the container and `extra` follow it. */
  title: string;
  /** Detail shown after the container, e.g. a file name or a shell. */
  extra?: string;
  /** Defaults to the normal popup width. */
  width?: number;
  /** Used as is for fixed-size popups; ignored with `fit`. */
  height?: number;
  minWidth?: number;
  minHeight?: number;
  /** Size the window to its content (forms). Default true. */
  fit?: boolean;
  /** The body has no padding or scrolling of its own. */
  bare?: boolean;
  /** The body, rendered inside the shared frame. */
  render: (windowId: string) => React.ReactNode;
}

export interface PopupHostOptions {
  /** The pane that owns the popups; used for centering without a click. */
  paneRef?: React.RefObject<HTMLElement | null>;
  /** The container name shown in every popup title. */
  label?: string;
  /** Told the id of every window opened, so the owner can close them. */
  onOpen?: (windowId: string) => void;
}

/**
 * Opens popup windows in the shared frame. Used inside a popup it opens a
 * child: placed over it, labelled like it and closed together with it.
 */
export function usePopups(
  host: PopupHostOptions = {},
): (options: PopupOptions) => string {
  const { openWindow } = useWindowManager();
  const parent = React.useContext(PopupWindowContext);

  return (options) => {
    const parentRect = parent?.getRect() ?? null;
    const paneRect = boxOf(host.paneRef?.current);
    const anchor = chooseAnchor({
      parentRect,
      pointer: lastPointer(),
      now: Date.now(),
      paneRect,
    });
    const width = options.width ?? POPUP_WIDTH.normal;
    const height = options.height ?? 300;
    const spec = {
      title: options.title,
      extra: options.extra,
      label: parent?.label ?? host.label ?? "",
      parentId: parent?.windowId,
      anchor,
      width,
      height,
      minWidth: options.minWidth ?? 360,
      minHeight: options.minHeight ?? 120,
      fit: options.fit ?? true,
      bare: options.bare ?? false,
    };
    const win: Omit<WindowInstance, "id" | "zIndex"> = {
      title: options.title,
      x: 0,
      y: 0,
      width,
      height,
      isMaximized: false,
      isMinimized: false,
      component: (windowId: string) => (
        <PopupFrame windowId={windowId} spec={spec}>
          {options.render(windowId)}
        </PopupFrame>
      ),
    };
    const id = openWindow(win);
    host.onOpen?.(id);
    return id;
  };
}

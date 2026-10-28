import React from "react";
import { DraggableWindow } from "../vendor/file-manager/components/DraggableWindow";
import { useWindowManager } from "../vendor/file-manager/components/WindowManager";
import { PopupWindowContext, type PopupWindowInfo } from "./PopupContext";
import {
  placePopup,
  type Box,
  type Placement,
  type PopupAnchor,
} from "./popupGeometry";
import { isOrphaned, mustRaiseOverParent } from "./popupFamily";
import { popupTitle } from "./popupTitle";
import { PopupHeader } from "./PopupHeader";

export interface PopupFrameSpec {
  /** What the window is ("Archive"), shown first in the title. */
  title: string;
  /** The container this popup belongs to, shown after the title. */
  label: string;
  /** Detail after the container (a file or folder path, a shell). */
  extra?: string;
  parentId?: string;
  anchor: PopupAnchor | null;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  /** Shrink or grow the window to exactly fit its content. */
  fit: boolean;
  /** No padding or scrolling of its own: the body lays itself out. */
  bare: boolean;
}

const toBox = (r: DOMRect): Box => ({
  left: r.left,
  top: r.top,
  width: r.width,
  height: r.height,
});

/**
 * The one frame every popup window uses: the editor's title bar and borders,
 * a "What — container · detail" title, placement over the parent popup or
 * centered in the owning pane, and closing together with the parent.
 */
export function PopupFrame({
  windowId,
  spec,
  children,
}: {
  windowId: string;
  spec: PopupFrameSpec;
  children: React.ReactNode;
}): React.ReactElement | null {
  const { closeWindow, minimizeWindow, maximizeWindow, focusWindow, windows } =
    useWindowManager();
  const current = windows.find((w) => w.id === windowId);
  const hostRef = React.useRef<HTMLDivElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<Box | null>(null);
  const [placement, setPlacement] = React.useState<Placement | null>(null);
  const [fitted, setFitted] = React.useState(!spec.fit);
  const [generation, setGeneration] = React.useState(0);

  // Place the window once the container (the window layer) can be measured.
  React.useLayoutEffect(() => {
    if (placement) return;
    const layer = hostRef.current?.closest(".window-container");
    const container = layer
      ? toBox(layer.getBoundingClientRect())
      : {
          left: 0,
          top: 0,
          width: window.innerWidth,
          height: window.innerHeight,
        };
    containerRef.current = container;
    setPlacement(
      placePopup(
        spec.anchor,
        {
          width: spec.width,
          height: spec.fit ? spec.minHeight : spec.height,
        },
        container,
      ),
    );
  }, [placement, spec]);

  // A new window comes up on top: the click that opened it also bubbles to the
  // opener's window and raises that one after this window got its z-index.
  const placed = placement !== null;
  React.useEffect(() => {
    if (placed) focusWindow(windowId);
  }, [placed, focusWindow, windowId]);

  // Stay above the owner: clicking the owner raises it, so raise this window
  // again (a chain of pickers converges, each one watching its own owner).
  const parentZ = windows.find((w) => w.id === spec.parentId)?.zIndex;
  const ownZ = current?.zIndex ?? 0;
  const raiseOverParent = placed && mustRaiseOverParent(parentZ, ownZ);
  React.useEffect(() => {
    if (raiseOverParent) focusWindow(windowId);
  }, [raiseOverParent, focusWindow, windowId]);

  // Fit the height to the content once, then remount at the final size.
  React.useLayoutEffect(() => {
    if (fitted || !placement) return;
    const body = bodyRef.current;
    const content = body?.parentElement;
    const frame = content?.parentElement;
    const container = containerRef.current;
    if (!body || !content || !frame || !container) return;
    const previous = body.style.height;
    body.style.height = "auto";
    const natural = body.offsetHeight;
    body.style.height = previous;
    const chrome = frame.offsetHeight - content.clientHeight;
    setPlacement(
      placePopup(
        spec.anchor,
        { width: spec.width, height: natural + chrome },
        container,
      ),
    );
    setFitted(true);
    setGeneration((g) => g + 1);
  }, [fitted, placement, spec]);

  // A child popup closes with its parent.
  const orphaned = isOrphaned(
    spec.parentId,
    windows.map((w) => w.id),
  );
  React.useEffect(() => {
    if (orphaned) closeWindow(windowId);
  }, [orphaned, closeWindow, windowId]);

  const info = React.useMemo<PopupWindowInfo>(
    () => ({
      windowId,
      label: spec.label,
      close: () => closeWindow(windowId),
      getRect: () => {
        const frame = hostRef.current?.firstElementChild;
        return frame ? toBox(frame.getBoundingClientRect()) : null;
      },
    }),
    [windowId, spec.label, closeWindow],
  );

  if (!current) return null;
  return (
    <PopupWindowContext.Provider value={info}>
      <div ref={hostRef} style={{ display: "contents" }}>
        {placement && (
          <DraggableWindow
            key={generation}
            title={popupTitle({
              what: spec.title,
              container: spec.label,
              extra: spec.extra,
            })}
            label=""
            titleContent={
              <PopupHeader
                what={spec.title}
                container={spec.label}
                extra={spec.extra}
              />
            }
            initialX={placement.x}
            initialY={placement.y}
            initialWidth={placement.width}
            initialHeight={placement.height}
            minWidth={Math.min(spec.minWidth, placement.width)}
            minHeight={Math.min(spec.minHeight, placement.height)}
            onClose={() => closeWindow(windowId)}
            onMinimize={() => minimizeWindow(windowId)}
            onMaximize={() => maximizeWindow(windowId)}
            onFocus={() => focusWindow(windowId)}
            isMaximized={current.isMaximized}
            zIndex={current.zIndex}
          >
            <div
              ref={bodyRef}
              className={
                spec.bare
                  ? "h-full overflow-hidden bg-background text-xs"
                  : "flex h-full flex-col gap-3 overflow-y-auto bg-background p-4 text-xs"
              }
            >
              {children}
            </div>
          </DraggableWindow>
        )}
      </div>
    </PopupWindowContext.Provider>
  );
}

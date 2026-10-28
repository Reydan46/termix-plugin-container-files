import type React from "react";
import { cn } from "@termix-ssh/plugin-sdk/ui";

interface ColumnResizeHandleProps {
  onMouseDown: (event: React.MouseEvent) => void;
  onDoubleClick: (event: React.MouseEvent) => void;
  onClick: (event: React.MouseEvent) => void;
  "data-resizing"?: string;
  title?: string;
}

/**
 * Thin grab area just inside the left edge of a list-view header cell. The parent cell
 * must be `relative`. Shows a hairline on hover and while dragging.
 */
export function ColumnResizeHandle({
  title,
  "data-resizing": resizing,
  ...handlers
}: ColumnResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title={title}
      data-column-resize-handle
      data-resizing={resizing}
      draggable={false}
      onDragStart={(event) => event.preventDefault()}
      className={cn(
        "absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize select-none group/handle z-10",
      )}
      {...handlers}
    >
      <div
        className={cn(
          "pointer-events-none absolute left-0 top-0.5 bottom-0.5 w-px transition-colors",
          resizing
            ? "bg-accent-brand"
            : "bg-transparent group-hover/handle:bg-accent-brand/60",
        )}
      />
    </div>
  );
}

import React from "react";

/** One button of the strip's panel group; add entries to extend the group. */
export interface PanelButton {
  id: string;
  label: string;
  icon?: React.ReactNode;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}

export type StripTone = "neutral" | "warn" | "error";

const TONE: Record<StripTone, string> = {
  neutral: "border-border text-muted-foreground",
  warn: "border-warning/40 bg-warning/10 text-warning",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
};

/**
 * The strip at the bottom of the file manager: the container state on the
 * left, a small group of panel buttons (Terminal, ...) on the right.
 */
export function StatusStrip({
  text,
  tooltip,
  tone,
  alert,
  buttons,
}: {
  text: string;
  /** Longer neutral detail shown as a tooltip. */
  tooltip?: string;
  tone: StripTone;
  alert?: boolean;
  buttons: PanelButton[];
}): React.ReactElement {
  return (
    <div
      className={`flex shrink-0 items-center gap-2 border-t px-3 py-1 text-xs ${TONE[tone]}`}
      role={alert ? "alert" : undefined}
    >
      <span className="min-w-0 flex-1 truncate" title={tooltip ?? text}>
        {text}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {buttons.map((b) => (
          <button
            key={b.id}
            type="button"
            className="flex items-center gap-1 border border-border px-2 py-0.5 text-foreground hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={b.disabled}
            title={b.title}
            onClick={b.onClick}
          >
            {b.icon}
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

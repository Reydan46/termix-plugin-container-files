import React from "react";
import { Container } from "lucide-react";

/**
 * The one title of every window: a chip saying WHAT it is, a second chip with
 * the container, then the extra detail (file, path, shell) as muted text.
 * Never wraps: the container chip and the detail truncate (with a tooltip),
 * the first chip stays whole.
 */
export function PopupHeader({
  what,
  container,
  extra,
}: {
  what: string;
  container?: string;
  extra?: string;
}): React.ReactElement {
  const box = container?.trim() ?? "";
  const detail = extra?.trim() ?? "";
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap">
      <span
        className="max-w-[45%] shrink-0 truncate border border-accent-brand/40 bg-accent-brand/15 px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-[0.15em] text-accent-brand"
        title={what}
      >
        {what}
      </span>
      {box !== "" && (
        <span
          className="inline-flex min-w-0 max-w-[40%] shrink items-center gap-1 border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-foreground"
          title={box}
        >
          <Container className="size-3 shrink-0 text-accent-brand" />
          <span className="truncate">{box}</span>
        </span>
      )}
      {detail !== "" && (
        <span
          className="min-w-0 flex-1 truncate text-[10px] font-medium leading-none text-muted-foreground"
          title={detail}
        >
          {detail}
        </span>
      )}
    </div>
  );
}

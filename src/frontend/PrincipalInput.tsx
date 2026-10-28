import React from "react";
import { createPortal } from "react-dom";
import { Input } from "@termix-ssh/plugin-sdk/ui";
import { ChevronDown } from "lucide-react";

export interface PrincipalOption {
  name: string;
  id: number;
}

const LIST_MAX = 160;
const LIST_GAP = 4;
/** Above the windows, below the confirm card. */
const LIST_Z = 2147482000;

interface ListPlace {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/** Where the list goes: under the field, or above it when there is no room. */
function placeList(field: DOMRect, count: number): ListPlace {
  const want = Math.min(LIST_MAX, count * 20 + 2);
  const below = window.innerHeight - field.bottom - LIST_GAP - 4;
  const above = field.top - LIST_GAP - 4;
  const up = below < want && above > below;
  const room = Math.max(40, up ? above : below);
  return up
    ? {
        left: field.left,
        width: field.width,
        bottom: window.innerHeight - field.top + LIST_GAP,
        maxHeight: Math.min(LIST_MAX, room),
      }
    : {
        left: field.left,
        width: field.width,
        top: field.bottom + LIST_GAP,
        maxHeight: Math.min(LIST_MAX, room),
      };
}

/**
 * A text field with a compact list of every known name. The list is never
 * narrowed by what is typed (typing only highlights and scrolls to the best
 * match), and the field keeps working when the list could not be loaded.
 */
export function PrincipalInput({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options?: PrincipalOption[];
  placeholder: string;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const activeRef = React.useRef<HTMLButtonElement>(null);
  const [place, setPlace] = React.useState<ListPlace | null>(null);
  const latest = React.useRef({ value, onChange, options });
  latest.current = { value, onChange, options };
  const typed = value.trim().toLowerCase();
  const match =
    options && typed
      ? (options.find((o) => o.name.toLowerCase() === typed) ??
        options.find((o) => String(o.id) === typed) ??
        options.find((o) => o.name.toLowerCase().startsWith(typed)))
      : undefined;

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node;
      if (rootRef.current?.contains(node) || listRef.current?.contains(node))
        return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the overlay glued to the field while the window moves or scrolls.
  const count = options?.length ?? 0;
  React.useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    let frame = 0;
    let last = "";
    const tick = () => {
      const el = rootRef.current;
      if (el) {
        const next = placeList(el.getBoundingClientRect(), count);
        const key = JSON.stringify(next);
        if (key !== last) {
          last = key;
          setPlace(next);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [open, count]);

  // The wheel over the field steps through the names. It must be a native,
  // non-passive listener: React's onWheel cannot cancel the page scroll.
  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { value: v, onChange: change, options: list } = latest.current;
      if (!list || list.length === 0 || e.deltaY === 0) return;
      e.preventDefault();
      const typedNow = v.trim().toLowerCase();
      const at = list.findIndex(
        (o) => o.name.toLowerCase() === typedNow || String(o.id) === typedNow,
      );
      const step = e.deltaY > 0 ? 1 : -1;
      const next =
        at < 0
          ? step > 0
            ? 0
            : list.length - 1
          : Math.min(list.length - 1, Math.max(0, at + step));
      change(list[next].name);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  React.useEffect(() => {
    if (open) activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [open, match?.name]);

  const hasOptions = !!options && options.length > 0;
  return (
    <div ref={rootRef} className="relative">
      <Input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (hasOptions) setOpen(true);
        }}
        onFocus={() => hasOptions && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="rounded-none border-border text-xs font-mono h-8 normal-case tracking-normal pr-7"
      />
      {hasOptions && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={placeholder}
          onClick={() => setOpen((o) => !o)}
          className="absolute right-0 top-0 flex h-8 w-7 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="size-3.5" />
        </button>
      )}
      {open &&
        hasOptions &&
        place &&
        createPortal(
          <div
            ref={listRef}
            role="listbox"
            style={{
              position: "fixed",
              left: place.left,
              width: place.width,
              top: place.top,
              bottom: place.bottom,
              maxHeight: place.maxHeight,
              zIndex: LIST_Z,
            }}
            className="overflow-y-auto border border-border bg-popover text-popover-foreground shadow-md normal-case tracking-normal"
          >
            {options.map((o) => {
              const active = match?.name === o.name;
              return (
                <button
                  key={o.name}
                  ref={active ? activeRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(o.name);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-2 px-2 py-0.5 text-left font-mono text-[11px] leading-5 hover:bg-muted ${
                    active ? "bg-accent-brand/10" : ""
                  }`}
                >
                  <span className="truncate">{o.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    ({o.id})
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

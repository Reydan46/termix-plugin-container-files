import React from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { AlertTriangle, HelpCircle } from "lucide-react";
import {
  POPUP_ACTIONS,
  POPUP_BUTTON,
  POPUP_BUTTON_DESTRUCTIVE,
  POPUP_BUTTON_PRIMARY,
  POPUP_TITLE_BAR,
} from "./popupStyles";
import { POPUP_WIDTH, boxOf, placePopup } from "./popupGeometry";
import { PopupHeader } from "./PopupHeader";
import { ConfirmStack, confirmKeyAction } from "./confirmKeys";
import { ensureDialogStyles } from "./dialogStyles";
import { moveDialogButtonFocus } from "./useDialogKeys";

const stack = new ConfirmStack();

export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button. Defaults to true, like the host's confirm. */
  destructive?: boolean;
}

interface ConfirmRequest extends ConfirmOptions {
  confirmLabel: string;
  cancelLabel: string;
  label: string;
  /** The header chip: what this window is ("Confirm"). */
  what: string;
  /** The pane the card is centered over; the viewport when absent. */
  pane?: Element | null;
}

/** Above every popup window and any host overlay. */
const CONFIRM_Z_INDEX = 2147483000;

function ConfirmCard({
  request,
  onResult,
}: {
  request: ConfirmRequest;
  onResult: (ok: boolean) => void;
}): React.ReactElement {
  const confirmRef = React.useRef<HTMLButtonElement>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);
  const [at, setAt] = React.useState<{ x: number; y: number } | null>(null);
  // Center over the owning pane (clamped to the viewport) once measured.
  React.useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const place = () => {
      const size = { width: el.offsetWidth, height: el.offsetHeight };
      const view = {
        left: 0,
        top: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      };
      const rect = boxOf(request.pane);
      const p = placePopup(
        rect ? { kind: "center", rect } : null,
        size,
        view,
        8,
      );
      setAt({ x: p.x, y: p.y });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [request.pane]);
  // The card stays hidden until it is placed, and a hidden button cannot take
  // focus (autoFocus runs too early), so focus it once it shows. Without this
  // the focus stayed on the file list that opened the card, and Enter went
  // there. The previous focus returns when the card closes.
  React.useLayoutEffect(() => {
    if (at) confirmRef.current?.focus({ preventScroll: true });
  }, [at]);
  const beforeRef = React.useRef<Element | null>(
    typeof document === "undefined" ? null : document.activeElement,
  );
  React.useEffect(() => {
    const before = beforeRef.current;
    const card = cardRef.current;
    return () => {
      const now = document.activeElement;
      const lost = !now || now === document.body || !!card?.contains(now);
      if (lost && before instanceof HTMLElement && before.isConnected)
        before.focus({ preventScroll: true });
    };
  }, []);
  const resultRef = React.useRef(onResult);
  resultRef.current = onResult;
  // Enter confirms and Esc cancels, before a terminal can see the key; only
  // the topmost card answers.
  React.useEffect(() => {
    ensureDialogStyles();
    const id = stack.push();
    const onKey = (e: KeyboardEvent) => {
      // Arrows move the selection between Cancel and Confirm.
      const moved = moveDialogButtonFocus(
        cardRef.current,
        {
          key: e.key,
          isComposing: e.isComposing,
          keyCode: e.keyCode,
          defaultPrevented: e.defaultPrevented,
          shiftKey: e.shiftKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
        },
        document.activeElement,
        stack.isTop(id),
      );
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const action = confirmKeyAction({
        key: e.key,
        topmost: stack.isTop(id),
        repeat: e.repeat,
        active: document.activeElement,
        confirmEl: confirmRef.current,
        cancelEl: cancelRef.current,
        body: document.body,
      });
      if (action === null) return;
      // The card is modal: no key goes on to the file pane behind it (its
      // listeners sit on document, e.g. Enter opens the selected file). Other
      // listeners on window run before the page, so stop those too.
      e.stopImmediatePropagation();
      if (action === "swallow") return;
      e.preventDefault();
      if (action === "confirm") resultRef.current(true);
      else if (action === "cancel") resultRef.current(false);
      else confirmRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      stack.remove(id);
    };
  }, []);

  const whatLabel = request.what;
  const destructive = request.destructive !== false;
  return (
    <div
      role="presentation"
      className="bg-black/50"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: CONFIRM_Z_INDEX,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onResult(false);
      }}
    >
      <div
        ref={cardRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={request.title}
        className="flex max-h-full flex-col overflow-hidden border border-border bg-[#0d0e0c] text-xs shadow-2xl"
        style={{
          position: "absolute",
          left: at?.x ?? 0,
          top: at?.y ?? 0,
          visibility: at ? "visible" : "hidden",
          width: POPUP_WIDTH.compact,
          maxWidth: "calc(100% - 16px)",
          maxHeight: "calc(100% - 16px)",
        }}
      >
        <div className={POPUP_TITLE_BAR}>
          <PopupHeader what={whatLabel} container={request.label} />
        </div>
        <div className="flex flex-col gap-3 overflow-y-auto bg-background p-4">
          <div className="flex items-start gap-3">
            <span
              className={
                destructive
                  ? "flex size-8 shrink-0 items-center justify-center border border-destructive/50 bg-destructive/10 text-destructive"
                  : "flex size-8 shrink-0 items-center justify-center border border-accent-brand/50 bg-accent-brand/10 text-accent-brand"
              }
            >
              {destructive ? (
                <AlertTriangle className="size-4" />
              ) : (
                <HelpCircle className="size-4" />
              )}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="break-words text-sm font-semibold text-foreground">
                {request.title}
              </div>
              {request.description && (
                <div className="break-words text-xs text-muted-foreground">
                  {request.description}
                </div>
              )}
            </div>
          </div>
          <div className={POPUP_ACTIONS}>
            <button
              ref={cancelRef}
              type="button"
              className={POPUP_BUTTON}
              onClick={() => onResult(false)}
            >
              {request.cancelLabel}
            </button>
            <button
              ref={confirmRef}
              type="button"
              className={
                destructive ? POPUP_BUTTON_DESTRUCTIVE : POPUP_BUTTON_PRIMARY
              }
              onClick={() => onResult(true)}
            >
              {request.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Shows one confirm card; `cancel` closes it with `false`. */
function openConfirm(request: ConfirmRequest): {
  promise: Promise<boolean>;
  cancel: () => void;
} {
  let finish: (ok: boolean) => void = () => {};
  const promise = new Promise<boolean>((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let done = false;
    finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
      // Unmount after the click or key handler has returned.
      setTimeout(() => {
        root.unmount();
        host.remove();
      }, 0);
    };
    root.render(<ConfirmCard request={request} onResult={finish} />);
  });
  return { promise, cancel: () => finish(false) };
}

/**
 * Replaces the host's confirm: the same question, in the popup look, centered
 * in the viewport and above every popup window. `label` names the container.
 */
export function useConfirm(
  label = "",
  paneRef?: React.RefObject<Element | null>,
): (options: ConfirmOptions) => Promise<boolean> {
  const { t } = useTranslation();
  const latest = React.useRef({ t, label, paneRef });
  latest.current = { t, label, paneRef };
  const open = React.useRef(new Set<() => void>());
  // The owner is gone: answer every card it left open with "no".
  React.useEffect(() => {
    const cards = open.current;
    return () => {
      for (const cancel of [...cards]) cancel();
      cards.clear();
    };
  }, []);
  return React.useCallback((options) => {
    const { promise, cancel } = openConfirm({
      ...options,
      label: latest.current.label,
      what: latest.current.t("fileManager.confirm"),
      pane: latest.current.paneRef?.current,
      confirmLabel:
        options.confirmLabel ?? latest.current.t("fileManager.confirm"),
      cancelLabel:
        options.cancelLabel ?? latest.current.t("fileManager.cancel"),
    });
    open.current.add(cancel);
    void promise.then(() => open.current.delete(cancel));
    return promise;
  }, []);
}

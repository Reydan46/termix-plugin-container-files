import React from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { AlertTriangle, Folder, File as FileIcon } from "lucide-react";
import { PopupHeader } from "../popup/PopupHeader";
import { POPUP_BUTTON, POPUP_BUTTON_DESTRUCTIVE } from "../popup/popupStyles";
import { DraggableWindow } from "../vendor/file-manager/components/DraggableWindow";
import { useWindowManager } from "../vendor/file-manager/components/WindowManager";
import { DIALOG_BUTTONS_CLASS } from "../popup/dialogStyles";
import { isTopmostWindow } from "../popup/dialogKeys";
import { focusDialogDefault, useDialogKeys } from "../popup/useDialogKeys";
import {
  keepBothName,
  resolveAll,
  resolveOne,
  type Decision,
  type ResolveState,
  type SourceItem,
} from "./conflicts";

/**
 * Names go into attributes and React text, which escape on their own: i18next
 * must not turn "&" or "<" in a name into entities.
 */
const NO_ESCAPE = { escapeValue: false };

const CHOICES: Decision[] = ["replace", "skip", "rename"];
const TIP_KEY: Record<Decision, string> = {
  replace: "workspace.choiceTip.replace",
  skip: "workspace.choiceTip.skip",
  rename: "workspace.choiceTip.rename",
};
const ALL_TIP_KEY: Record<Decision, string> = {
  replace: "workspace.choiceTip.allReplace",
  skip: "workspace.choiceTip.allSkip",
  rename: "workspace.choiceTip.allRename",
};

/**
 * Pop-up window shown before a transfer when names already exist at the
 * target: replace, skip or keep both, per item or for all at once.
 */
export function ConflictWindow({
  windowId,
  title,
  items,
  renamed,
  targetLabel,
  onResult,
}: {
  windowId: string;
  title: string;
  items: SourceItem[];
  /** Keep-both result per item name, as the transfer will really name it. */
  renamed: Record<string, string>;
  targetLabel: string;
  /** Called exactly once: the decisions, or null when cancelled. */
  onResult: (decisions: Record<string, Decision> | null) => void;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const { closeWindow, minimizeWindow, maximizeWindow, focusWindow, windows } =
    useWindowManager();
  const current = windows.find((w) => w.id === windowId);
  const [state, setState] = React.useState<ResolveState>(() => ({
    pending: items,
    decisions: {},
  }));
  const settled = React.useRef(false);
  const settle = (value: Record<string, Decision> | null) => {
    if (settled.current) return;
    settled.current = true;
    onResult(value);
    closeWindow(windowId);
  };
  // Escape cancels; there is no default choice: arrows pick a choice (the "all
  // items" row first), then Enter presses the focused one.
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const onDialogKey = useDialogKeys({
    rootRef: bodyRef,
    topmost: isTopmostWindow(windowId, windows),
    onCancel: () => settle(null),
  });
  const shown = current !== undefined;
  React.useEffect(() => {
    if (shown) focusDialogDefault(bodyRef.current);
  }, [shown]);
  if (!current) return null;
  const apply = (next: ResolveState) => {
    setState(next);
    if (next.pending.length === 0) settle(next.decisions);
  };
  return (
    <>
      {/* Modal: dims the page and blocks clicks, just below this window. */}
      {!current.isMinimized && (
        <div
          role="presentation"
          className="bg-black/50"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: Math.max(0, current.zIndex - 1),
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      )}
      <DraggableWindow
        title={title}
        label=""
        titleContent={<PopupHeader what={title} />}
        initialX={current.x}
        initialY={current.y}
        initialWidth={current.width}
        initialHeight={current.height}
        minWidth={380}
        minHeight={300}
        onClose={() => settle(null)}
        onMinimize={() => minimizeWindow(windowId)}
        onMaximize={() => maximizeWindow(windowId)}
        onFocus={() => focusWindow(windowId)}
        isMaximized={current.isMaximized}
        zIndex={current.zIndex}
      >
        <div
          ref={bodyRef}
          tabIndex={-1}
          onKeyDown={onDialogKey}
          className="flex h-full flex-col gap-3 overflow-hidden bg-background p-4 text-xs outline-none"
        >
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center border border-destructive/50 bg-destructive/10 text-destructive">
              <AlertTriangle className="size-4" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="break-words text-sm font-semibold text-foreground">
                {title}
              </div>
              <div className="break-words text-xs text-muted-foreground">
                {t("workspace.conflictDesc", {
                  count: state.pending.length,
                  target: targetLabel,
                  interpolation: NO_ESCAPE,
                })}
              </div>
            </div>
          </div>
          <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto border border-border">
            {state.pending.map((item) => {
              const rowTip = (c: Decision) =>
                t(TIP_KEY[c], {
                  name: item.name,
                  renamed: renamed[item.name] ?? keepBothName(item),
                  interpolation: NO_ESCAPE,
                });
              return (
                <li
                  key={item.name}
                  className="flex items-center gap-2 px-2 py-1.5 text-xs"
                >
                  {item.isDirectory ? (
                    <Folder className="size-3.5 shrink-0 text-accent-brand" />
                  ) : (
                    <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate" title={item.name}>
                    {item.name}
                  </span>
                  <div
                    role="group"
                    aria-label={item.name}
                    className={`flex shrink-0 ${DIALOG_BUTTONS_CLASS}`}
                  >
                    {CHOICES.map((c) => (
                      <button
                        key={c}
                        type="button"
                        title={rowTip(c)}
                        aria-label={`${t(`workspace.choice.${c}`)}: ${item.name}`}
                        aria-description={rowTip(c)}
                        className={`border px-2 py-0.5 ${
                          c === "replace"
                            ? "border-destructive/60 text-destructive hover:bg-destructive/10"
                            : "border-border hover:bg-muted/40"
                        }`}
                        onClick={() => apply(resolveOne(state, item.name, c))}
                      >
                        {t(`workspace.choice.${c}`)}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          <div
            className={`flex shrink-0 flex-wrap items-center justify-end gap-2 pt-1 ${DIALOG_BUTTONS_CLASS}`}
          >
            <span className="mr-auto text-muted-foreground">
              {t("workspace.conflictAll")}
            </span>
            {CHOICES.map((c) => (
              <button
                key={c}
                type="button"
                title={t(ALL_TIP_KEY[c])}
                aria-label={`${t("workspace.conflictAll")} ${t(`workspace.choice.${c}`)}`}
                aria-description={t(ALL_TIP_KEY[c])}
                className={
                  c === "replace" ? POPUP_BUTTON_DESTRUCTIVE : POPUP_BUTTON
                }
                onClick={() => apply(resolveAll(state, c))}
              >
                {t(`workspace.choice.${c}`)}
              </button>
            ))}
          </div>
        </div>
      </DraggableWindow>
    </>
  );
}

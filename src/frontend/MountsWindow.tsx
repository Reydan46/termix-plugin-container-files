import React from "react";
import { DIALOG_DEFAULT } from "./popup/useDialogKeys";
import { Loader2 } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { usePopupWindow } from "./popup/PopupContext";
import { POPUP_ACTIONS, POPUP_BUTTON } from "./popup/popupStyles";
import { fetchMounts } from "./containerFsApi";
import type { MountInfo } from "./mountLookup";

/** Lists every mount of the container; each row can open its path (which closes the window). */
export function MountsWindow({
  containerKey,
  initial,
  onGoTo,
}: {
  containerKey: string;
  initial: MountInfo[];
  onGoTo: (destination: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const { close } = usePopupWindow();
  const [mounts, setMounts] = React.useState<MountInfo[]>(initial);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    fetchMounts(containerKey, controller.signal)
      .then((list) => {
        setMounts(list);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError(t("containerFiles.mountsLoadFailed"));
        setLoading(false);
      });
    return () => controller.abort();
  }, [containerKey]);

  const typeLabel = (type: MountInfo["type"]) =>
    t(
      type === "bind"
        ? "containerFiles.mountTypeBind"
        : type === "volume"
          ? "containerFiles.mountTypeVolume"
          : "containerFiles.mountTypeTmpfs",
    );

  return (
    <>
      <div className="max-h-64 min-h-0 flex-1 overflow-y-auto border border-border">
        {loading && mounts.length === 0 && (
          <p className="p-1.5 text-xs text-muted-foreground">
            <Loader2 className="inline size-3.5 animate-spin" />
          </p>
        )}
        {error && <p className="p-1.5 text-xs text-destructive">{error}</p>}
        {!loading && !error && mounts.length === 0 && (
          <p className="p-1.5 text-xs text-muted-foreground">
            {t("containerFiles.mountsEmpty")}
          </p>
        )}
        {mounts.map((m) => {
          const source = m.source || m.name;
          const access = m.readOnly
            ? "containerFiles.mountRo"
            : "containerFiles.mountRw";
          return (
            <div
              key={m.destination}
              className="flex items-center gap-1.5 border-b border-border px-1.5 py-0.5 text-xs last:border-b-0"
            >
              <span className="shrink-0 border border-border px-1 text-[10px] uppercase leading-4">
                {typeLabel(m.type)}
              </span>
              <span
                className="min-w-0 flex-1 truncate font-mono"
                title={m.destination}
              >
                {m.destination}
              </span>
              <span
                className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
                title={source}
              >
                {source}
              </span>
              <span
                className={`shrink-0 font-mono ${
                  m.readOnly ? "text-amber-500" : "text-muted-foreground"
                }`}
                title={t(access)}
              >
                {t(
                  m.readOnly
                    ? "containerFiles.mountRoShort"
                    : "containerFiles.mountRwShort",
                )}
              </span>
              <button
                type="button"
                className={`${POPUP_BUTTON} shrink-0`}
                onClick={() => {
                  onGoTo(m.destination);
                  close();
                }}
              >
                {t("containerFiles.mountGoTo")}
              </button>
            </div>
          );
        })}
      </div>
      <div className={POPUP_ACTIONS}>
        <button
          type="button"
          {...DIALOG_DEFAULT}
          className={POPUP_BUTTON}
          onClick={close}
        >
          {t("containerFiles.mountClose")}
        </button>
      </div>
    </>
  );
}

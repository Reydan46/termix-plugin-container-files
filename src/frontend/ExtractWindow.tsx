import React from "react";
import { FolderOpen } from "lucide-react";
import { Input } from "@termix-ssh/plugin-sdk/ui";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { usePopupWindow } from "./popup/PopupContext";
import {
  POPUP_ACTIONS,
  POPUP_BUTTON,
  POPUP_BUTTON_PRIMARY,
  POPUP_FIELD_LABEL,
  POPUP_HINT,
  POPUP_ICON_BUTTON,
} from "./popup/popupStyles";
import { usePathPicker } from "./PathPickerWindow";
import { extractDestValid, startDir } from "./pathHelpers";

/** The body of the popup asking where to extract an archive. */
export function ExtractWindow({
  containerKey,
  archiveName,
  initialDest,
  onExtract,
}: {
  containerKey: string;
  archiveName: string;
  initialDest: string;
  onExtract: (dest: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const { close } = usePopupWindow();
  const pick = usePathPicker(containerKey);
  const [dest, setDest] = React.useState(initialDest);
  const valid = extractDestValid(dest);

  const submit = () => {
    if (!valid) return;
    close();
    onExtract(dest.trim().replace(/\/+$/, "") || "/");
  };

  return (
    <form
      className="flex flex-1 flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className={`truncate ${POPUP_HINT}`} title={archiveName}>
        {archiveName}
      </p>
      <label className={POPUP_FIELD_LABEL}>
        {t("containerFiles.extractTo")}
        <div className="flex gap-1">
          <Input
            value={dest}
            autoFocus
            onChange={(e) => setDest(e.target.value)}
            aria-invalid={!valid}
            className="font-mono text-xs normal-case tracking-normal"
          />
          <button
            type="button"
            className={POPUP_ICON_BUTTON}
            title={t("containerFiles.pickFolder")}
            aria-label={t("containerFiles.pickFolder")}
            onClick={() =>
              pick({
                title: t("containerFiles.pickFolder"),
                initialDir: startDir(dest, true),
                mode: "folder",
                onPick: setDest,
              })
            }
          >
            <FolderOpen className="size-4" />
          </button>
        </div>
      </label>
      <p className={POPUP_HINT}>{t("containerFiles.extractToHint")}</p>
      <div className={POPUP_ACTIONS}>
        <button type="button" className={POPUP_BUTTON} onClick={close}>
          {t("fileManager.cancel")}
        </button>
        <button
          type="submit"
          disabled={!valid}
          className={POPUP_BUTTON_PRIMARY}
        >
          {t("containerFiles.extractAction")}
        </button>
      </div>
    </form>
  );
}

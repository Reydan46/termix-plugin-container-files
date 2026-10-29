import React from "react";
import { DIALOG_DEFAULT } from "./popup/useDialogKeys";
import { Input } from "@termix-ssh/plugin-sdk/ui";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { usePopupWindow } from "./popup/PopupContext";
import {
  POPUP_ACTIONS,
  POPUP_BUTTON,
  POPUP_BUTTON_PRIMARY,
  POPUP_FIELD_LABEL,
  POPUP_HINT,
} from "./popup/popupStyles";
import {
  COMPRESS_FORMATS,
  defaultArchiveName,
  finalArchiveName,
} from "./compressHelpers";

/** The body of the popup that asks how to compress the selected files. */
export function CompressWindow({
  fileNames,
  onCompress,
}: {
  fileNames: string[];
  onCompress: (archiveName: string, format: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const { close } = usePopupWindow();
  const [archiveName, setArchiveName] = React.useState(() =>
    defaultArchiveName(fileNames),
  );
  const [format, setFormat] = React.useState<string>("zip");
  const canSubmit = archiveName.trim() !== "";

  const submit = () => {
    if (!canSubmit) return;
    close();
    onCompress(finalArchiveName(archiveName, format), format);
  };

  return (
    <form
      className="flex flex-1 flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className={POPUP_HINT}>
        {t("fileManager.compressFilesDesc", { count: fileNames.length })}
      </p>
      <label className={POPUP_FIELD_LABEL}>
        {t("fileManager.archiveName")}
        <Input
          value={archiveName}
          autoFocus
          onChange={(e) => setArchiveName(e.target.value)}
          placeholder={t("fileManager.enterArchiveName")}
          className="rounded-none border-border bg-muted/50 text-xs normal-case tracking-normal"
        />
      </label>
      <div className={POPUP_FIELD_LABEL}>
        {t("fileManager.compressionFormat")}
        <div className="grid grid-cols-3 gap-1" role="radiogroup">
          {COMPRESS_FORMATS.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={format === f}
              onClick={() => setFormat(f)}
              className={`border py-1.5 text-xs font-bold uppercase tracking-widest transition-colors ${
                format === f
                  ? "border-accent-brand/40 bg-accent-brand/10 text-accent-brand"
                  : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              .{f}
            </button>
          ))}
        </div>
      </div>
      <div className="border border-border bg-muted/10 p-3">
        <p className={`${POPUP_FIELD_LABEL} mb-2`}>
          {t("fileManager.selectedFiles")}:
        </p>
        <ul className="space-y-1 text-xs">
          {fileNames.slice(0, 5).map((name, index) => (
            <li key={index} className="truncate font-medium text-foreground">
              {name}
            </li>
          ))}
          {fileNames.length > 5 && (
            <li className="text-muted-foreground">
              {t("fileManager.andMoreFiles", { count: fileNames.length - 5 })}
            </li>
          )}
        </ul>
      </div>
      <div className={POPUP_ACTIONS}>
        <button type="button" className={POPUP_BUTTON} onClick={close}>
          {t("fileManager.cancel")}
        </button>
        <button
          type="submit"
          {...DIALOG_DEFAULT}
          disabled={!canSubmit}
          className={POPUP_BUTTON_PRIMARY}
        >
          {t("fileManager.compress")}
        </button>
      </div>
    </form>
  );
}

import React from "react";
import { Checkbox, Input } from "@termix-ssh/plugin-sdk/ui";
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
import { FolderOpen } from "lucide-react";
import { ContainerApiError } from "./containerFsApi";
import { usePathPicker } from "./PathPickerWindow";
import { startDir } from "./pathHelpers";

/** Where the link is created: a name is relative to `dir`, a path is kept. */
export function linkPathOf(dir: string, name: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith("/")) return trimmed;
  return dir === "/" ? `/${trimmed}` : `${dir.replace(/\/+$/, "")}/${trimmed}`;
}

/** Whether the two fields can be submitted (mirrors the backend checks). */
export function symlinkInputValid(name: string, target: string): boolean {
  const n = name.trim();
  if (!n || n === "/" || n.includes("\0")) return false;
  if (n.endsWith("/")) return false;
  return target.length > 0 && !target.includes("\0");
}

/**
 * A floating window (like the permissions one) to create a symbolic link or,
 * for an existing one, to change what it points at.
 */
export function SymlinkWindow({
  mode,
  dir,
  containerKey,
  initialName,
  initialTarget,
  onSubmit,
}: {
  mode: "create" | "edit";
  /** The folder a relative link name is created in. */
  dir: string;
  containerKey: string;
  /** The link name (create) or its full path (edit, not changeable). */
  initialName: string;
  initialTarget: string;
  /** Throws to keep the window open (the message is shown in it). */
  onSubmit: (path: string, target: string, force: boolean) => Promise<void>;
}): React.ReactElement {
  const { t } = useTranslation();
  const { close } = usePopupWindow();
  const pick = usePathPicker(containerKey);
  const [name, setName] = React.useState(initialName);
  const [target, setTarget] = React.useState(initialTarget);
  const [overwrite, setOverwrite] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const editing = mode === "edit";
  const valid = symlinkInputValid(name, target);

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(
        editing ? initialName : linkPathOf(dir, name),
        target,
        editing || overwrite,
      );
      close();
    } catch (e) {
      const exists = e instanceof ContainerApiError && e.code === "EXISTS";
      setError(
        exists
          ? t("containerFiles.linkExists")
          : e instanceof Error
            ? e.message
            : t("containerFiles.linkFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  const pickButton = POPUP_ICON_BUTTON;
  const label = POPUP_FIELD_LABEL;

  return (
    <form
      className="flex flex-1 flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className={label}>
        {t("containerFiles.linkName")}
        <div className="flex gap-1">
          <Input
            value={name}
            readOnly={editing}
            autoFocus={!editing}
            onChange={(e) => setName(e.target.value)}
            className="font-mono text-xs normal-case tracking-normal"
          />
          {!editing && (
            <button
              type="button"
              className={pickButton}
              title={t("containerFiles.pickFolder")}
              aria-label={t("containerFiles.pickFolder")}
              onClick={() =>
                pick({
                  title: t("containerFiles.pickFolder"),
                  initialDir: startDir(dir, true),
                  mode: "folder",
                  onPick: (folder) => {
                    const base = name.trim().split("/").pop() ?? "";
                    setName(folder === "/" ? "/" + base : folder + "/" + base);
                  },
                })
              }
            >
              <FolderOpen className="size-4" />
            </button>
          )}
        </div>
      </label>
      {!editing && (
        <p className={`break-all ${POPUP_HINT}`}>
          {t("containerFiles.linkCreatedIn", {
            path: linkPathOf(dir, name || "…"),
          })}
        </p>
      )}
      <label className={label}>
        {t("containerFiles.linkTarget")}
        <div className="flex gap-1">
          <Input
            value={target}
            autoFocus={editing}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="/path/or/../relative"
            className="font-mono text-xs normal-case tracking-normal"
          />
          <button
            type="button"
            className={pickButton}
            title={t("containerFiles.pickTarget")}
            aria-label={t("containerFiles.pickTarget")}
            onClick={() =>
              pick({
                title: t("containerFiles.pickTarget"),
                initialDir: startDir(
                  target.startsWith("/") ? target : dir,
                  false,
                ),
                mode: "any",
                onPick: setTarget,
              })
            }
          >
            <FolderOpen className="size-4" />
          </button>
        </div>
      </label>
      <p className={POPUP_HINT}>{t("containerFiles.linkTargetHint")}</p>
      {!editing && (
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={overwrite}
            onCheckedChange={(on) => setOverwrite(on === true)}
          />
          {t("containerFiles.linkOverwrite")}
        </label>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className={POPUP_ACTIONS}>
        <button type="button" className={POPUP_BUTTON} onClick={close}>
          {t("fileManager.cancel")}
        </button>
        <button
          type="submit"
          disabled={!valid || saving}
          className={POPUP_BUTTON_PRIMARY}
        >
          {editing ? t("fileManager.save") : t("containerFiles.linkCreate")}
        </button>
      </div>
    </form>
  );
}

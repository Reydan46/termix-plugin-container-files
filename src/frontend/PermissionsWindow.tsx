import React from "react";
import { DIALOG_DEFAULT } from "./popup/useDialogKeys";
import { Checkbox, Input } from "@termix-ssh/plugin-sdk/ui";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { usePopupWindow } from "./popup/PopupContext";
import {
  POPUP_ACTIONS,
  POPUP_BUTTON,
  POPUP_BUTTON_PRIMARY,
  POPUP_FIELD_LABEL,
  POPUP_HINT,
} from "./popup/popupStyles";
import type { FileItem } from "./vendor/file-manager/host-types";
import {
  fetchPrincipals,
  type ApplyScope,
  type Principals,
} from "./containerFsApi";
import { PrincipalInput } from "./PrincipalInput";
import {
  MODE_ACCESS,
  MODE_CLASSES,
  MODE_SPECIAL,
  formatMode,
  hasAccess,
  hasSpecial,
  parseMode,
  parseOctalMode,
  sanitizeOctalInput,
  setAccess,
  setSpecial,
} from "./permissionMode";

/** The octal text for the field: 3 digits, or 4 when a special bit is set. */
function modeText(mode: number): string {
  const full = formatMode(mode);
  return mode > 0o777 ? full : full.slice(1);
}

const SCOPES: ApplyScope[] = ["all", "files", "dirs"];

/** "Apply ... recursively" with the kind of entries it reaches, in one row. */
function RecursiveRow({
  label,
  checked,
  onChecked,
  scope,
  onScope,
}: {
  label: string;
  checked: boolean;
  onChecked: (on: boolean) => void;
  scope: ApplyScope;
  onScope: (scope: ApplyScope) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const names: Record<ApplyScope, string> = {
    all: t("containerFiles.scopeAll"),
    files: t("containerFiles.scopeFiles"),
    dirs: t("containerFiles.scopeDirs"),
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <label className="flex items-center gap-2 text-xs">
        <Checkbox
          checked={checked}
          onCheckedChange={(on) => onChecked(on === true)}
        />
        {label}
      </label>
      <select
        value={scope}
        disabled={!checked}
        aria-label={label}
        onChange={(e) => onScope(e.target.value as ApplyScope)}
        className="h-6 rounded-none border border-border bg-muted/50 px-1 text-[11px] disabled:opacity-50"
      >
        {SCOPES.map((value) => (
          <option key={value} value={value}>
            {names[value]}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * A floating window (like the editor) for permissions and owner: a checkbox
 * grid, special bits and an octal field that stay in sync, then owner and group.
 */
export function PermissionsWindow({
  file,
  containerKey,
  onSave,
  onChangeOwner,
}: {
  file: FileItem;
  containerKey: string;
  /** Receives the full 4-digit mode, e.g. "0755". */
  onSave: (
    file: FileItem,
    permissions: string,
    recursive: boolean,
    scope: ApplyScope,
  ) => Promise<void>;
  onChangeOwner: (
    file: FileItem,
    owner: string,
    recursive: boolean,
    scope: ApplyScope,
  ) => Promise<void>;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const { close } = usePopupWindow();
  const [mode, setMode] = React.useState(() => parseMode(file.permissions));
  const [text, setText] = React.useState(() => modeText(mode));
  const [ownerName, setOwnerName] = React.useState(file.owner ?? "");
  const [groupName, setGroupName] = React.useState(file.group ?? "");
  const [permRecursive, setPermRecursive] = React.useState(false);
  const [permScope, setPermScope] = React.useState<ApplyScope>("all");
  const [ownerRecursive, setOwnerRecursive] = React.useState(false);
  const [ownerScope, setOwnerScope] = React.useState<ApplyScope>("all");
  const octalRef = React.useRef<HTMLSpanElement>(null);
  const modeRef = React.useRef(mode);
  modeRef.current = mode;
  const [saving, setSaving] = React.useState(false);
  const [principals, setPrincipals] = React.useState<Principals | undefined>();

  React.useEffect(() => {
    let cancelled = false;
    fetchPrincipals(containerKey)
      .then((value) => !cancelled && setPrincipals(value))
      .catch(() => {
        // The owner and group lists are only suggestions; typing still works.
      });
    return () => {
      cancelled = true;
    };
  }, [containerKey]);

  const isDir = file.type === "directory";
  const valid = parseOctalMode(text) !== null;
  const update = (next: number) => {
    setMode(next);
    setText(modeText(next));
  };
  const updateRef = React.useRef(update);
  updateRef.current = update;

  // The wheel over the octal field steps the mode; a native non-passive
  // listener, because React's onWheel cannot cancel the page scroll.
  React.useEffect(() => {
    const el = octalRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      const next = modeRef.current + (e.deltaY < 0 ? 1 : -1);
      updateRef.current(Math.min(0o7777, Math.max(0, next)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const onText = (raw: string) => {
    const clean = sanitizeOctalInput(raw);
    setText(clean);
    const parsed = parseOctalMode(clean);
    if (parsed !== null) setMode(parsed);
  };

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      const ownerChanged = ownerName.trim() !== (file.owner ?? "");
      const groupChanged = groupName.trim() !== (file.group ?? "");
      if (ownerChanged || groupChanged) {
        const spec = `${ownerChanged ? ownerName.trim() : ""}${groupChanged ? `:${groupName.trim()}` : ""}`;
        await onChangeOwner(file, spec, isDir && ownerRecursive, ownerScope);
      }
      await onSave(file, formatMode(mode), isDir && permRecursive, permScope);
      close();
    } catch {
      // the caller already reported the failure; keep the window open
    } finally {
      setSaving(false);
    }
  };

  const classLabel = {
    owner: `${t("fileManager.owner")}${file.owner ? ` (${file.owner})` : ""}`,
    group: `${t("fileManager.group")}${file.group ? ` (${file.group})` : ""}`,
    other: t("fileManager.others"),
  };
  const accessLabel = {
    read: t("fileManager.read"),
    write: t("fileManager.write"),
    execute: t("fileManager.execute"),
  };
  const specialLabel = {
    setuid: t("containerFiles.setuid"),
    setgid: t("containerFiles.setgid"),
    sticky: t("containerFiles.sticky"),
  };
  const head =
    "py-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground";

  return (
    <>
      <p className={`break-all ${POPUP_HINT}`}>{file.path}</p>

      <div className="border border-border">
        <div className="grid grid-cols-[1fr_64px_64px_64px] border-b border-border bg-muted/50">
          <div className={head} />
          {MODE_ACCESS.map((a) => (
            <div
              key={a}
              className={`${head} border-l border-border text-center`}
            >
              {accessLabel[a]}
            </div>
          ))}
        </div>
        {MODE_CLASSES.map((cls, i) => (
          <div
            key={cls}
            className={`grid grid-cols-[1fr_64px_64px_64px] ${
              i < MODE_CLASSES.length - 1 ? "border-b border-border" : ""
            }`}
          >
            <div className="px-3 py-1 text-xs font-semibold">
              {classLabel[cls]}
            </div>
            {MODE_ACCESS.map((a) => (
              <div
                key={a}
                className="flex items-center justify-center border-l border-border py-1"
              >
                <Checkbox
                  aria-label={`${classLabel[cls]} ${accessLabel[a]}`}
                  checked={hasAccess(mode, cls, a)}
                  onCheckedChange={(on) =>
                    update(setAccess(mode, cls, a, on === true))
                  }
                />
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
          {t("containerFiles.specialBits")}
        </span>
        {MODE_SPECIAL.map((s) => (
          <label key={s} className="flex items-center gap-1.5 text-xs">
            <Checkbox
              checked={hasSpecial(mode, s)}
              onCheckedChange={(on) => update(setSpecial(mode, s, on === true))}
            />
            {specialLabel[s]}
          </label>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-xs font-bold uppercase tracking-widest text-muted-foreground">
            {t("fileManager.octal")}
          </span>
          <span ref={octalRef} className="inline-flex">
            <Input
              value={text}
              onChange={(e) => onText(e.target.value)}
              inputMode="numeric"
              maxLength={4}
              aria-invalid={!valid}
              aria-label={t("fileManager.octal")}
              className="h-8 w-20 rounded-none border-border bg-muted/50 text-center font-mono text-xs"
            />
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {t("fileManager.currentPermissions")}: {file.permissions || "-"}
          </span>
        </div>
        {!valid && (
          <p className="text-[11px] text-destructive">
            {t("containerFiles.octalInvalid")}
          </p>
        )}
        {isDir && (
          <RecursiveRow
            label={t("containerFiles.permRecursive")}
            checked={permRecursive}
            onChecked={setPermRecursive}
            scope={permScope}
            onScope={setPermScope}
          />
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
          {t("containerFiles.ownerSection")}
        </span>
        <div className="grid grid-cols-2 gap-2">
          <label className={POPUP_FIELD_LABEL}>
            {t("fileManager.owner")}
            <PrincipalInput
              value={ownerName}
              onChange={setOwnerName}
              options={principals?.users.map((u) => ({
                name: u.name,
                id: u.uid,
              }))}
              placeholder={t("containerFiles.nameOrId")}
            />
          </label>
          <label className={POPUP_FIELD_LABEL}>
            {t("fileManager.group")}
            <PrincipalInput
              value={groupName}
              onChange={setGroupName}
              options={principals?.groups.map((g) => ({
                name: g.name,
                id: g.gid,
              }))}
              placeholder={t("containerFiles.nameOrId")}
            />
          </label>
        </div>
        {isDir && (
          <RecursiveRow
            label={t("containerFiles.ownerRecursive")}
            checked={ownerRecursive}
            onChecked={setOwnerRecursive}
            scope={ownerScope}
            onScope={setOwnerScope}
          />
        )}
      </div>

      <div className={POPUP_ACTIONS}>
        <button type="button" className={POPUP_BUTTON} onClick={close}>
          {t("fileManager.cancel")}
        </button>
        <button
          type="button"
          {...DIALOG_DEFAULT}
          disabled={!valid || saving}
          className={POPUP_BUTTON_PRIMARY}
          onClick={() => void save()}
        >
          {t("fileManager.save")}
        </button>
      </div>
    </>
  );
}

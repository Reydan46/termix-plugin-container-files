import type { TranslateFn } from "@termix-ssh/plugin-sdk/frontend";
import { ArrowUpFromLine } from "lucide-react";
import { TransferProgressBar } from "./vendor/file-manager/components/TransferProgressBar";

interface UploadProgressToastProps {
  t: TranslateFn;
  /** Names of the files being sent right now. */
  names: string[];
  done: number;
  count: number;
  loaded: number;
  total: number;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

export function UploadProgressToast({
  t,
  names,
  done,
  count,
  loaded,
  total,
}: UploadProgressToastProps) {
  const percent =
    total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : undefined;
  const title =
    names.length === 1
      ? t("containerFiles.uploadingFile", { name: names[0] })
      : t("containerFiles.uploading", { count });
  return (
    <div className="flex w-[min(calc(100vw-5rem),288px)] max-w-full flex-col gap-2 pr-2">
      <p className="flex items-center gap-2 text-sm font-medium leading-tight">
        <ArrowUpFromLine className="size-3.5 shrink-0 text-accent-brand" />
        <span className="truncate">{title}</span>
      </p>
      <TransferProgressBar value={percent} label={title} />
      <div className="flex items-center justify-between gap-3 pr-1 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {total > 0
            ? t("fileManager.downloadProgressBytes", {
                transferred: formatBytes(loaded),
                total: formatBytes(total),
              })
            : formatBytes(loaded)}
        </span>
        <span className="shrink-0 tabular-nums">
          {t("containerFiles.uploadingProgress", { done, count })}
        </span>
      </div>
    </div>
  );
}

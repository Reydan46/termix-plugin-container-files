import type { TranslateFn } from "@termix-ssh/plugin-sdk/frontend";
import { ArrowRightLeft } from "lucide-react";
import { TransferProgressBar } from "../vendor/file-manager/components/TransferProgressBar";
import { formatBytes } from "../UploadProgressToast";

/** Progress toast of one cross-pane transfer (dismissed by its owner). */
export function TransferToast({
  t,
  title,
  loaded,
  total,
}: {
  t: TranslateFn;
  title: string;
  loaded: number;
  /** 0 when the size is unknown. */
  total: number;
}) {
  const percent =
    total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : undefined;
  return (
    <div className="flex w-[min(calc(100vw-5rem),288px)] max-w-full flex-col gap-2 pr-2">
      <p className="flex items-center gap-2 text-sm font-medium leading-tight">
        <ArrowRightLeft className="size-3.5 shrink-0 text-accent-brand" />
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
        {percent !== undefined && (
          <span className="shrink-0 tabular-nums">{percent}%</span>
        )}
      </div>
    </div>
  );
}

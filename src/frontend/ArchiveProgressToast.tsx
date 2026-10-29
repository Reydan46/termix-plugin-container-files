import { toast } from "sonner";
import type { TranslateFn } from "@termix-ssh/plugin-sdk/frontend";
import { Archive } from "lucide-react";
import { TransferProgressBar } from "./vendor/file-manager/components/TransferProgressBar";
import { formatBytes } from "./UploadProgressToast";
import type { Origin } from "./sessionOrigin";
import { operationStatus, type OpStatus, type OpTrack } from "./containerFsApi";
import {
  OpCancelled,
  formatElapsed,
  newOpId,
  progressPercent,
} from "./archiveProgressHelpers";

function ArchiveProgressToast({
  t,
  title,
  status,
  elapsedMs,
}: {
  t: TranslateFn;
  title: string;
  status: OpStatus | null;
  elapsedMs: number;
}) {
  const percent = progressPercent(status);
  const stage = t(`containerFiles.opStage.${status?.stage ?? "preparing"}`);
  const processed = status?.processedBytes;
  let detail = "";
  if (processed !== undefined && status?.totalBytes) {
    detail = t("containerFiles.opProgressOf", {
      processed: formatBytes(processed),
      total: `${status.approximate ? "~" : ""}${formatBytes(status.totalBytes)}`,
    });
  } else if (processed !== undefined && processed > 0) {
    detail = t("containerFiles.opProgressSoFar", {
      processed: formatBytes(processed),
    });
  }
  return (
    <div className="flex w-[min(calc(100vw-5rem),288px)] max-w-full flex-col gap-2 pr-2">
      <p className="flex items-center gap-2 text-sm font-medium leading-tight">
        <Archive className="size-3.5 shrink-0 text-accent-brand" />
        <span className="truncate">{title}</span>
      </p>
      <TransferProgressBar value={percent} label={title} />
      <div className="flex items-center justify-between gap-3 pr-1 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {detail ? `${stage} - ${detail}` : stage}
        </span>
        <span className="shrink-0 tabular-nums">
          {percent !== undefined ? `${percent}% - ` : ""}
          {formatElapsed(elapsedMs)}
        </span>
      </div>
    </div>
  );
}

/**
 * Runs a compress / extract with a progress toast (stage, elapsed time, a bar
 * when the size is known) and a Cancel button that aborts the request, which
 * stops the work on the server too. The toast is always dismissed; failures
 * are rethrown, a cancel throws OpCancelled.
 */
export async function runWithProgress<T>(opts: {
  t: TranslateFn;
  /** The origin of the session the operation runs in. */
  origin: Origin;
  kind: "compress" | "extract" | "append" | "delete";
  name: string;
  task: (track: OpTrack) => Promise<T>;
}): Promise<T> {
  const { t, origin, kind, name, task } = opts;
  const titleKey = {
    compress: "containerFiles.compressingName",
    extract: "containerFiles.extractingName",
    append: "containerFiles.appendingName",
    delete: "containerFiles.deletingFromName",
  }[kind];
  const title = t(titleKey, { name });
  const opId = newOpId(kind);
  const controller = new AbortController();
  const startedAt = Date.now();
  let status: OpStatus | null = null;
  let closed = false;
  const cancel = {
    label: t("fileManager.cancel"),
    onClick: () => controller.abort(),
  };
  const render = () => {
    if (closed) return;
    toast.loading(
      <ArchiveProgressToast
        t={t}
        title={title}
        status={status}
        elapsedMs={Date.now() - startedAt}
      />,
      { id, duration: Infinity, cancel },
    );
  };
  const id = toast.loading(title, { cancel, duration: Infinity });
  render();
  const timer = setInterval(() => {
    void operationStatus(opId, origin).then((s) => {
      if (s && !closed) status = s;
      render();
    });
  }, 500);
  try {
    return await task({ opId, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new OpCancelled();
    throw error;
  } finally {
    closed = true;
    clearInterval(timer);
    toast.dismiss(id);
  }
}

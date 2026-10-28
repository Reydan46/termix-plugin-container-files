import React from "react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { useConfirm } from "./popup/useConfirm";
import { ContainerApiError, fsApi } from "./containerFsApi";
import { runWithProgress } from "./ArchiveProgressToast";
import { OpCancelled } from "./archiveProgressHelpers";

/**
 * Extracts chosen archive entries into a folder. On a name clash it asks
 * before overwriting. Resolves true when something was extracted.
 */
export function useArchiveExtract(
  /** The container name shown in the confirm's title. */
  label = "",
): (
  key: string,
  archive: string,
  entries: string[],
  dest: string,
) => Promise<boolean> {
  const { t } = useTranslation();
  const confirm = useConfirm(label);
  const latest = React.useRef({ t, confirm });
  latest.current = { t, confirm };

  return React.useCallback(async (key, archive, entries, dest) => {
    const { t: tr, confirm: ask } = latest.current;
    const extractWith = (overwrite: boolean) =>
      runWithProgress({
        t: tr,
        kind: "extract",
        name: archive.split("/").pop() || archive,
        task: (track) =>
          fsApi.extractEntries(key, archive, entries, dest, overwrite, track),
      });
    try {
      try {
        await extractWith(false);
      } catch (error) {
        if (!(error instanceof ContainerApiError) || error.code !== "EXISTS") {
          throw error;
        }
        const yes = await ask({
          title: tr("containerFiles.extractOverwriteTitle"),
          description: tr("containerFiles.archiveExtractOverwriteDesc", {
            dest,
          }),
          confirmLabel: tr("containerFiles.overwrite"),
          destructive: true,
        });
        if (!yes) return false;
        await extractWith(true);
      }
      toast.success(
        tr("containerFiles.archiveExtractedCount", {
          count: entries.length,
          dest,
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof OpCancelled) {
        toast.info(tr("containerFiles.opCancelled"));
        return false;
      }
      toast.error(
        error instanceof Error
          ? error.message
          : tr("containerFiles.extractFailed"),
      );
      return false;
    }
  }, []);
}

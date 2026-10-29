import React from "react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { useConfirm } from "./popup/useConfirm";
import {
  ContainerApiError,
  SERVER_OLDER_CODE,
  fsApi,
  listFiles,
  type ExtractChoices,
} from "./containerFsApi";
import { runWithProgress } from "./ArchiveProgressToast";
import { originOfSession } from "./sessionOrigin";
import { OpCancelled } from "./archiveProgressHelpers";
import { extractQuestions, planExtraction } from "./extractConflicts";
import { useAskConflicts } from "./workspace/useConflictWindow";

/**
 * Extracts an archive (`entries` null) or chosen entries of it into a folder.
 * Names that already exist in the folder are put to the conflict window
 * (replace, skip or keep both, per item or for all), the same one transfers
 * between panes use. A server too old to plan the extraction gets the old
 * flow: try, and on a clash ask once whether to overwrite everything.
 * Resolves true when something was extracted.
 */
export function useArchiveExtract(
  /** The container name shown in the confirm's title. */
  label = "",
): (
  key: string,
  archive: string,
  entries: string[] | null,
  dest: string,
) => Promise<boolean> {
  const { t } = useTranslation();
  const confirm = useConfirm(label);
  const askConflicts = useAskConflicts();
  const latest = React.useRef({ t, confirm, askConflicts });
  latest.current = { t, confirm, askConflicts };

  return React.useCallback(async (key, archive, entries, dest) => {
    const { t: tr, confirm: ask, askConflicts: askWindow } = latest.current;
    const name = archive.split("/").pop() || archive;
    const extractWith = (overwrite: boolean, choices?: ExtractChoices) =>
      runWithProgress({
        t: tr,
        origin: originOfSession(key),
        kind: "extract",
        name,
        task: (track) =>
          entries === null
            ? fsApi.extract(key, archive, dest, overwrite, track, choices)
            : fsApi.extractEntries(
                key,
                archive,
                entries,
                dest,
                overwrite,
                track,
                choices,
              ),
      });

    // The old flow, for a server that cannot plan an extraction.
    const legacy = async (): Promise<boolean> => {
      try {
        await extractWith(false);
      } catch (error) {
        if (!(error instanceof ContainerApiError) || error.code !== "EXISTS") {
          throw error;
        }
        const yes = await ask({
          title: tr("containerFiles.extractOverwriteTitle"),
          description:
            entries === null
              ? tr("containerFiles.extractOverwriteDesc", { name })
              : tr("containerFiles.archiveExtractOverwriteDesc", { dest }),
          confirmLabel: tr("containerFiles.overwrite"),
          destructive: true,
        });
        if (!yes) return false;
        await extractWith(true);
      }
      return true;
    };

    try {
      let plan: Awaited<ReturnType<typeof fsApi.extractPlan>> | null = null;
      try {
        plan = await fsApi.extractPlan(key, archive, entries ?? undefined);
      } catch (error) {
        if (
          !(error instanceof ContainerApiError) ||
          error.code !== SERVER_OLDER_CODE
        ) {
          throw error;
        }
      }

      let count = entries?.length ?? 0;
      // A cut-off listing may miss names: ask nothing clever, use the old flow.
      if (plan === null || plan.truncated) {
        if (!(await legacy())) return false;
      } else {
        const items = plan.items;
        count = items.length;
        // A folder that cannot be listed is treated as empty; the server still
        // refuses to overwrite silently (EXISTS) when it is not.
        const existing = await listFiles(key, dest).then(
          (r) => r.files.map((f) => f.name),
          () => [] as string[],
        );
        const { asking, renamed } = extractQuestions(items, existing);
        let decisions = {};
        if (asking.length > 0) {
          const answer = await askWindow(asking, dest, renamed);
          if (!answer) return false;
          decisions = answer;
        }
        const run = planExtraction(items, existing, decisions);
        if (run.count === 0) {
          toast.info(tr("workspace.nothingToTransfer"));
          return false;
        }
        count = run.count;
        if (run.choices) {
          await extractWith(true, run.choices);
        } else {
          // No conflicts: nothing to overwrite. Every conflict "replace": overwrite.
          await extractWith(asking.length > 0);
        }
      }
      toast.success(
        entries === null
          ? tr("containerFiles.extractDone", { name })
          : tr("containerFiles.archiveExtractedCount", { count, dest }),
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

import React from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { useWindowManager } from "../vendor/file-manager/components/WindowManager";
import { ConflictWindow } from "./ConflictWindow";
import type { Decision, SourceItem } from "./conflicts";

/**
 * Opens the conflict window (replace, skip or keep both for each name that
 * already exists) and resolves with the choices, or null when it is cancelled.
 * Shared by cross-pane transfers and by extracting an archive.
 */
export function useAskConflicts(): (
  items: SourceItem[],
  targetLabel: string,
  renamed: Record<string, string>,
) => Promise<Record<string, Decision> | null> {
  const { t } = useTranslation();
  const { openWindow } = useWindowManager();
  return (items, targetLabel, renamed) =>
    new Promise((resolve) => {
      const title = t("workspace.conflictTitle");
      openWindow({
        title,
        x: 200,
        y: 140,
        width: 520,
        height: 420,
        isMaximized: false,
        isMinimized: false,
        component: (windowId: string) => (
          <ConflictWindow
            windowId={windowId}
            title={title}
            items={items}
            renamed={renamed}
            targetLabel={targetLabel}
            onResult={resolve}
          />
        ),
      });
    });
}

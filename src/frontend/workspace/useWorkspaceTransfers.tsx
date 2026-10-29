import React from "react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  cancelTransfer,
  copyBetween,
  fsApi,
  joinPath,
  listFiles,
  localDownload,
  localUpload,
  newTransferId,
  targetKey,
  transferStatus,
} from "../containerFsApi";
import { isVirtualPath } from "../archivePath";
import { originOfSession } from "../sessionOrigin";
import {
  listLocalDirectory,
  localPathsExist,
  trashLocalPaths,
} from "../vendor/file-manager/lib/local-files";
import { localBaseName } from "./localPaths";
import { useAskConflicts } from "./useConflictWindow";
import {
  baseName,
  findConflicts,
  keepBothNames,
  parentPath,
  planConflicts,
  type Decision,
  type SourceItem,
} from "./conflicts";
import { TransferToast } from "./TransferToast";
import { TransferQueue } from "./transferQueue";

export interface TransferSource {
  path: string;
  name: string;
  isDirectory: boolean;
}

export interface TransferRequest {
  /** containerId null = this computer (Desktop only). */
  from: { containerId: string | null; items: TransferSource[] };
  to: { containerId: string | null; dir: string };
  move: boolean;
  /**
   * Allows `move` for items of this computer: after a complete transfer they
   * are sent to the trash. Drag and drop never sets it.
   */
  trashLocalSource?: boolean;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Cross-pane transfers: conflict questions in a pop-up window, a queue so
 * transfers run one at a time, a progress toast with Cancel that is always
 * dismissed, and a refresh of the affected panes afterwards.
 */
export function useWorkspaceTransfers({
  sessionId,
  containerLabel,
  refreshContainers,
}: {
  sessionId: string;
  containerLabel: (containerId: string | null) => string;
  /** null stands for the local pane. */
  refreshContainers: (containerIds: (string | null)[]) => void;
}) {
  const { t } = useTranslation();
  const queue = React.useMemo(() => new TransferQueue(), []);
  React.useEffect(() => () => queue.cancelAll(), [queue]);

  const origin = originOfSession(sessionId);

  const latest = React.useRef({ t, containerLabel, refreshContainers });
  latest.current = { t, containerLabel, refreshContainers };

  const askConflicts = useAskConflicts();

  const run = async (
    request: TransferRequest,
    plan: { renames: Record<string, string>; skip: string[] },
    existing: Set<string>,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { t: tr, containerLabel: label } = latest.current;
    const { from, to, move } = request;
    const skip = new Set(plan.skip);
    const items = from.items.filter((i) => !skip.has(i.name));
    const target = label(to.containerId);
    const title =
      items.length === 1
        ? tr(move ? "workspace.moving" : "workspace.copying", {
            name: items[0].name,
            target,
          })
        : tr(move ? "workspace.movingMany" : "workspace.copyingMany", {
            count: items.length,
            target,
          });
    const transferId = newTransferId("c2c");
    const sameContainer =
      from.containerId !== null && from.containerId === to.containerId;
    const cheapMove = move && sameContainer;
    // Local-pane transfers are tracked by this device's backend even when the
    // container lives on the server; only container to container runs there.
    const trackedOn =
      from.containerId === null || to.containerId === null ? "local" : origin;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });

    let loaded = 0;
    let total = 0;
    let closed = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    const cancel = {
      label: tr("fileManager.cancel"),
      onClick: () => {
        controller.abort();
        void cancelTransfer(transferId, trackedOn);
      },
    };
    const render = () => {
      if (closed || controller.signal.aborted) return;
      toast.loading(
        <TransferToast t={tr} title={title} loaded={loaded} total={total} />,
        { id, duration: Infinity, cancel },
      );
    };
    const id = toast.loading(title, { cancel, duration: Infinity });
    let done = false;
    // Entries the copy left out: the source must stay whole then.
    let partial = false;
    try {
      if (cheapMove) {
        for (const item of items) {
          if (controller.signal.aborted) break;
          const name = plan.renames[item.name] ?? item.name;
          const dest = joinPath(to.dir, name);
          const key = targetKey(sessionId, to.containerId);
          await fsApi.move(
            key,
            item.path,
            dest,
            existing.has(name) && !(item.name in plan.renames),
          );
        }
      } else {
        render();
        poll = setInterval(() => {
          void transferStatus(transferId, trackedOn).then((s) => {
            if (!s || closed) return;
            loaded = s.bytes;
            total = s.total;
            render();
          });
        }, 500);
        if (from.containerId === null && to.containerId !== null) {
          await localUpload(
            sessionId,
            {
              transferId,
              containerId: to.containerId,
              dir: to.dir,
              localPaths: items.map((i) => i.path),
              renames: plan.renames,
              skip: plan.skip,
            },
            controller.signal,
          );
        } else if (from.containerId !== null && to.containerId === null) {
          const res = await localDownload(
            sessionId,
            {
              transferId,
              containerId: from.containerId,
              paths: items.map((i) => i.path),
              localDir: to.dir,
              renames: plan.renames,
              skip: plan.skip,
            },
            controller.signal,
          );
          // The backend throws when nothing was written; entries it left
          // out (links, names the disk refused) are still worth telling.
          if (
            res?.success === false ||
            (res.files ?? 0) + (res.dirs ?? 0) === 0
          )
            throw new Error(tr("workspace.nothingWritten"));
          if (res.skipped?.length) {
            partial = true;
            toast.warning(
              tr("workspace.copySkipped", {
                count: res.skipped.length,
                names: res.skipped.slice(0, 3).join(", "),
              }),
            );
          }
        } else if (from.containerId !== null && to.containerId !== null) {
          await copyBetween(
            sessionId,
            {
              transferId,
              from: {
                containerId: from.containerId,
                paths: items.map((i) => i.path),
              },
              to: { containerId: to.containerId, dir: to.dir },
              renames: plan.renames,
              skip: plan.skip,
            },
            controller.signal,
          );
        } else {
          throw new Error(t("containerFiles.localToLocal"));
        }
        if (move && partial) {
          toast.warning(tr("workspace.moveKeptSource"));
        } else if (move && !controller.signal.aborted) {
          try {
            if (from.containerId === null) {
              const res = await trashLocalPaths(items.map((i) => i.path));
              if (res.failed.length > 0)
                throw new Error(res.failed.map((f) => f.path).join(", "));
            } else {
              await fsApi.delete(
                targetKey(sessionId, from.containerId),
                items.map((i) => i.path),
              );
            }
          } catch (error) {
            toast.error(
              tr("workspace.moveCleanupFailed", {
                error: errorText(error, ""),
              }),
            );
          }
        }
      }
      done = !controller.signal.aborted;
      if (!done) toast.info(tr("workspace.cancelled"));
    } catch (error) {
      if (controller.signal.aborted) {
        toast.info(tr("workspace.cancelled"));
      } else {
        toast.error(
          errorText(
            error,
            tr(move ? "workspace.moveFailed" : "workspace.copyFailed"),
          ),
        );
      }
    } finally {
      // The progress toast has a Cancel button and no timeout: always remove it.
      closed = true;
      clearInterval(poll);
      toast.dismiss(id);
      signal.removeEventListener("abort", onAbort);
    }
    if (done) {
      toast.success(
        tr(move ? "workspace.moved" : "workspace.copied", {
          count: items.length,
          target,
        }),
      );
    }
    // A cancelled copy may have left a partial tree: always look again.
    latest.current.refreshContainers([from.containerId, to.containerId]);
    return done;
  };

  /** Resolves true when the transfer completed. */
  const transfer = async (request: TransferRequest): Promise<boolean> => {
    const { t: tr, containerLabel: label } = latest.current;
    const { from, to } = request;
    // Moving out of this computer deletes local files: a copy unless asked.
    const move =
      request.move && (from.containerId !== null || !!request.trashLocalSource);
    if (from.containerId === null && to.containerId === null) return false;
    if (to.containerId !== null && isVirtualPath(to.dir)) {
      toast.error(tr("containerFiles.archiveReadOnly"));
      return false;
    }
    if (
      from.containerId !== null &&
      from.items.some((i) => isVirtualPath(i.path))
    ) {
      toast.error(tr("workspace.archiveSource"));
      return false;
    }
    const sameContainer =
      from.containerId !== null && from.containerId === to.containerId;
    let items = from.items.filter(
      (i) =>
        !(
          sameContainer &&
          i.isDirectory &&
          (to.dir === i.path || to.dir.startsWith(`${i.path}/`))
        ),
    );
    if (items.length === 0) {
      toast.error(tr("workspace.intoItself"));
      return false;
    }
    if (from.containerId === null) {
      // A stale clipboard (files moved or deleted since): skip what is gone.
      try {
        const there = new Set(await localPathsExist(items.map((i) => i.path)));
        const gone = items.filter((i) => !there.has(i.path));
        if (gone.length > 0) {
          toast.warning(
            tr("workspace.missingSkipped", {
              names: gone.map((i) => localBaseName(i.path)).join(", "),
            }),
          );
          items = items.filter((i) => there.has(i.path));
          if (items.length === 0) return false;
        }
      } catch {
        // Cannot tell: let the transfer report its own error.
      }
    }
    let existing: Set<string>;
    try {
      existing = new Set(
        to.containerId === null
          ? (await listLocalDirectory(to.dir)).entries.map((e) => e.name)
          : (
              await listFiles(targetKey(sessionId, to.containerId), to.dir)
            ).files.map((f) => f.name),
      );
    } catch (error) {
      toast.error(errorText(error, tr("containerFiles.listFailed")));
      return false;
    }
    const nameOf = from.containerId === null ? localBaseName : baseName;
    const sources: SourceItem[] = items.map((i) => ({
      name: nameOf(i.path),
      isDirectory: i.isDirectory,
    }));
    const selfNames = new Set(
      sameContainer
        ? items
            .filter((i) => parentPath(i.path) === to.dir)
            .map((i) => baseName(i.path))
        : [],
    );
    const asking = findConflicts(sources, existing).filter(
      (s) => !selfNames.has(s.name),
    );
    let decisions: Record<string, Decision> = {};
    if (asking.length > 0) {
      const answer = await askConflicts(
        asking,
        label(to.containerId),
        keepBothNames(sources, existing, asking, { selfNames, move }),
      );
      if (!answer) return false;
      decisions = answer;
    }
    const plan = planConflicts(sources, existing, decisions, {
      selfNames,
      move,
    });
    if (plan.count === 0) {
      toast.info(tr("workspace.nothingToTransfer"));
      return false;
    }
    let ok = false;
    await queue.enqueue(async (signal) => {
      ok = await run(
        { ...request, move, from: { ...from, items } },
        plan,
        existing,
        signal,
      );
    });
    return ok;
  };

  return { transfer, queue };
}

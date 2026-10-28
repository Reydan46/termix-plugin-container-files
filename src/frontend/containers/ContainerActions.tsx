import React from "react";
import {
  Pause,
  Play,
  PlayCircle,
  RefreshCw,
  RotateCw,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button } from "@termix-ssh/plugin-sdk/ui";
import {
  sessionApi,
  targetKey,
  type ContainerAction,
  type ContainerLiveState,
} from "../containerFsApi";
import { containerName, type ContainerInfo } from "../types";

// Start, stop, pause and restart follow the Docker plugin's cards (Apache-2.0):
// no confirmation, a toast per outcome, then the state is read again.

type Busy = ContainerAction | null;

const DONE_KEY: Record<ContainerAction, string> = {
  start: "started",
  stop: "stopped",
  pause: "paused",
  unpause: "resumed",
  restart: "restarted",
};
const FAIL_KEY: Record<ContainerAction, string> = {
  start: "failedStart",
  stop: "failedStop",
  pause: "failedPause",
  unpause: "failedResume",
  restart: "failedRestart",
};

/** Which actions a state offers, in display order. */
export function actionsFor(state: string): ContainerAction[] {
  const out: ContainerAction[] = [];
  if (state !== "running" && state !== "paused") out.push("start");
  if (state === "running" || state === "paused") out.push("stop");
  if (state === "running") out.push("pause");
  if (state === "paused") out.push("unpause");
  out.push("restart");
  return out;
}

export function ContainerActions({
  sessionId,
  container,
  onChanged,
  className = "",
}: {
  sessionId: string;
  container: ContainerInfo;
  /** Called with the new state after an action went through. */
  onChanged: (id: string, state: ContainerLiveState | null) => void;
  className?: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const [busy, setBusy] = React.useState<Busy>(null);
  const mounted = React.useRef(true);
  React.useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const run = async (event: React.MouseEvent, action: ContainerAction) => {
    event.stopPropagation();
    if (busy) return;
    const name = containerName(container);
    setBusy(action);
    try {
      const result = await sessionApi.action(
        targetKey(sessionId, container.id),
        action,
      );
      toast.success(t(`containers.${DONE_KEY[action]}`, { name }));
      onChanged(container.id, result);
    } catch (error) {
      toast.error(
        t(`containers.${FAIL_KEY[action]}`, {
          name,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      onChanged(container.id, null);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const icon = (action: ContainerAction, node: React.ReactNode) =>
    busy === action ? <RefreshCw className="size-3 animate-spin" /> : node;

  const spec: Record<
    ContainerAction,
    { label: string; icon: React.ReactNode; tone: string }
  > = {
    start: {
      label: t("containers.start"),
      icon: <Play className="size-3" />,
      tone: "text-accent-brand",
    },
    stop: {
      label: t("containers.stop"),
      icon: <Square className="size-3" />,
      tone: "text-destructive",
    },
    pause: {
      label: t("containers.pause"),
      icon: <Pause className="size-3" />,
      tone: "",
    },
    unpause: {
      label: t("containers.resume"),
      icon: <PlayCircle className="size-3" />,
      tone: "",
    },
    restart: {
      label: t("containers.restart"),
      icon: <RotateCw className="size-3" />,
      tone: "",
    },
  };

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {actionsFor(container.state).map((action) => (
        <Button
          key={action}
          variant="ghost"
          size="icon-xs"
          title={spec[action].label}
          aria-label={spec[action].label}
          disabled={
            busy !== null ||
            (action === "restart" && container.state === "exited")
          }
          className={spec[action].tone}
          onClick={(event: React.MouseEvent) => void run(event, action)}
        >
          {icon(action, spec[action].icon)}
        </Button>
      ))}
    </div>
  );
}

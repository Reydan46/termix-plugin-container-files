/* eslint-disable react-hooks/exhaustive-deps */
import React from "react";
import { Box, FolderArchive, RefreshCw } from "lucide-react";
import {
  useConnectionRetry,
  useHost,
  useTranslation,
  usePluginUiPreferences,
  type TabProps,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  BackButton,
  BrowserSignInDialog,
  Button,
  ConnectionLogProvider,
  ConnectionScreen,
  PanelSearch,
  PanelShell,
  Segmented,
  SSHAuthDialog,
  TOTPDialog,
  ViewToggle,
  resolveConnectionOrigin,
  resolveRemoteHostId,
  useAdaptivePolling,
  useConnectionLog,
  type GridSize,
} from "@termix-ssh/plugin-sdk/ui";
import {
  ContainerApiError,
  sessionApi,
  type ContainerLiveState,
} from "./containerFsApi";
import {
  type ApiConnectionLog,
  type ConnectResult,
  type ContainerHost,
  type ContainerInfo,
  type Runtime,
} from "./types";
import { ContainerList, ContainerTable } from "./containers/ContainerList";
import { ContainerWorkspace } from "./workspace/ContainerWorkspace";
import { runtimeLabel } from "./runtimeLabel";
import { planConnect, type BlockedKey } from "./connectOrigin";
import { getApp } from "./app";

interface PromptState {
  kind: "totp" | "browser";
  sessionId: string;
  prompt?: string;
  isPassword?: boolean;
  url?: string;
  code?: string;
  label?: string;
}

function toContainerHost(record: Record<string, unknown>): ContainerHost {
  return {
    id: Number(record.id),
    name: typeof record.name === "string" ? record.name : undefined,
    ip: String(record.ip ?? ""),
    port: Number(record.port ?? 22),
    username: typeof record.username === "string" ? record.username : undefined,
  };
}

function ContainerFilesInner({
  host,
  rawHost,
  title,
  isVisible,
  onClose,
}: {
  host?: ContainerHost;
  rawHost?: Record<string, unknown>;
  title?: string;
  isVisible: boolean;
  onClose?: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const { addLog, setLogs, clearLogs } = useConnectionLog();
  const { values: prefs, set: setPref } = usePluginUiPreferences<{
    containerLayout: "card" | "table";
    containerColumns: GridSize;
  }>();

  const liveRecord = useHost(host?.id);
  const currentHost = React.useMemo(
    () =>
      liveRecord
        ? toContainerHost(liveRecord as unknown as Record<string, unknown>)
        : host,
    [liveRecord, host],
  );

  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [runtime, setRuntime] = React.useState<Runtime | null>(null);
  const [runtimeVersion, setRuntimeVersion] = React.useState<string | null>(
    null,
  );
  const [connected, setConnected] = React.useState(false);
  const [containers, setContainers] = React.useState<ContainerInfo[]>([]);
  const signatureRef = React.useRef("");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  // A workspace pane is showing the container picker: keep the list fresh.
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [actionsHost, setActionsHost] = React.useState<HTMLElement | null>(
    null,
  );
  const [layout, setLayout] = React.useState<"card" | "table">(
    prefs.containerLayout ?? "card",
  );
  const [columns, setColumns] = React.useState<GridSize>(
    prefs.containerColumns ?? "auto",
  );
  const [isConnecting, setIsConnecting] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [loadedOnce, setLoadedOnce] = React.useState(false);
  // Why this host cannot connect right now (shown instead of the connect screen).
  const [blocked, setBlocked] = React.useState<BlockedKey | null>(null);
  const [prompt, setPrompt] = React.useState<PromptState | null>(null);
  const [showAuthDialog, setShowAuthDialog] = React.useState(false);
  const [authReason, setAuthReason] = React.useState<
    "no_keyboard" | "auth_failed" | "timeout"
  >("no_keyboard");
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [retryCount, setRetryCount] = React.useState(0);
  const initializingRef = React.useRef(false);
  const retryRef = React.useRef<ReturnType<typeof useConnectionRetry> | null>(
    null,
  );

  React.useEffect(() => {
    setContainers([]);
    setSelectedId(null);
    setSessionId(null);
    setConnected(false);
  }, [host?.id]);

  const applyConnectResult = (
    sid: string,
    result: ConnectResult,
    clearAfter: boolean,
  ) => {
    if (result.connectionLogs) setLogs(result.connectionLogs);

    if (result.requires_browser_sign_in) {
      setPrompt({
        kind: "browser",
        sessionId: sid,
        url: result.url || "",
        code: result.code || "",
        label: result.label || "",
      });
      return;
    }
    if (result.requires_totp) {
      if (result.retry) {
        addLog({
          type: "error",
          stage: "auth",
          message: t("containerFiles.totpFailed"),
        });
      }
      setPrompt({
        kind: "totp",
        sessionId: sid,
        prompt: result.prompt || t("containerFiles.verificationCodePrompt"),
        isPassword: result.isPassword,
      });
      return;
    }
    if (result.status === "auth_required") {
      setAuthReason(
        result.reason === "no_keyboard" ? "no_keyboard" : "auth_failed",
      );
      setShowAuthDialog(true);
      return;
    }
    setPrompt(null);
    setSessionId(sid);
    setRuntime(result.runtime ?? null);
    setRuntimeVersion(result.runtimeVersion ?? null);
    setConnected(true);
    if (clearAfter) setTimeout(() => clearLogs(), 1000);
    retryRef.current?.markConnected();
  };

  const reportFailure = (error: unknown, fallback: string) => {
    const logs =
      error instanceof ContainerApiError
        ? (error.data?.connectionLogs as ApiConnectionLog[] | undefined)
        : undefined;
    if (logs?.length) {
      setLogs(logs);
    } else {
      addLog({
        type: "error",
        stage: "connection",
        message: error instanceof Error ? error.message : fallback,
      });
    }
    retryRef.current?.markFailed();
  };

  const connect = async (credentials?: {
    userProvidedPassword?: string;
    userProvidedSshKey?: string;
    userProvidedKeyPassword?: string;
  }) => {
    if (!currentHost?.id) return;
    const localHostId = currentHost.id;
    setIsConnecting(true);
    try {
      const plan = await planConnect({
        desktopAvailable: getApp().desktop.available,
        localHostId,
        resolveOrigin: () =>
          resolveConnectionOrigin(
            (liveRecord ?? rawHost ?? {}) as {
              connectionOrigin?: "local" | "remote" | null;
            },
          ),
        remoteServerUrl: () => getApp().desktop.remoteServerUrl(),
        remoteHostId: () =>
          resolveRemoteHostId(rawHost?.syncId as string | null | undefined),
        preflight: (sid) => sessionApi.status(sid),
      });
      if (plan.kind === "blocked") {
        setBlocked(plan.key);
        return;
      }
      setBlocked(null);
      const sid = plan.sessionId;
      const result = await sessionApi.connect(sid, plan.hostId, credentials);
      applyConnectResult(sid, result, !credentials);
    } catch (error) {
      reportFailure(error, t("containerFiles.connectionFailed"));
    } finally {
      setIsConnecting(false);
    }
  };

  React.useEffect(() => {
    if (!currentHost?.id) return;
    if (initializingRef.current || sessionId) return;
    initializingRef.current = true;
    clearLogs();
    void connect().finally(() => {
      initializingRef.current = false;
    });
  }, [currentHost?.id, retryCount]);

  React.useEffect(() => {
    if (!sessionId) return;
    return () => {
      sessionApi.disconnect(sessionId).catch(() => {
        // Closing is best effort; the backend drops idle sessions on its own.
      });
    };
  }, [sessionId]);

  React.useEffect(() => {
    if (!sessionId || !isVisible) return;
    const keepalive = setInterval(
      () => {
        sessionApi.keepalive(sessionId).catch(() => {
          // A missed ping is retried on the next tick.
        });
      },
      10 * 60 * 1000,
    );
    return () => clearInterval(keepalive);
  }, [sessionId, isVisible]);

  const refreshContainers = React.useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await sessionApi.containers(sessionId);
      signatureRef.current = JSON.stringify(data.containers);
      setContainers(data.containers);
    } catch {
      // the next poll tries again
    }
  }, [sessionId]);

  React.useEffect(() => {
    setLoadedOnce(false);
  }, [sessionId]);

  useAdaptivePolling(
    async () => {
      if (!sessionId) return;
      setLoading((was) => (loadedOnce ? was : true));
      const data = await sessionApi.containers(sessionId);
      const signature = JSON.stringify(data.containers);
      const changed = signature !== signatureRef.current;
      signatureRef.current = signature;
      setContainers(data.containers);
      setLoading(false);
      setLoadedOnce(true);
      return changed;
    },
    { minIntervalMs: 5000, maxIntervalMs: 30000, stablePollsPerStep: 3 },
    !!sessionId && isVisible && connected && (!selectedId || pickerOpen),
    {
      onError: () => {
        setLoading(false);
        setLoadedOnce(true);
      },
    },
  );

  // A row changes at once from what an action or a state poll reported, and
  // the real list is read again right after.
  const patchContainer = React.useCallback(
    (id: string, live: ContainerLiveState | null) => {
      if (!live) return;
      setContainers((prev) => {
        const next = prev.map((c) =>
          c.id === id && c.state !== live.state
            ? { ...c, state: live.state }
            : c,
        );
        return next.some((c, i) => c !== prev[i]) ? next : prev;
      });
    },
    [],
  );

  const handleChanged = React.useCallback(
    (id: string, live: ContainerLiveState | null) => {
      patchContainer(id, live);
      void refreshContainers();
    },
    [patchContainer, refreshContainers],
  );

  const handleTotpSubmit = async (code: string) => {
    if (!prompt || prompt.kind !== "totp" || !code) return;
    const sid = prompt.sessionId;
    setPrompt(null);
    setIsConnecting(true);
    try {
      applyConnectResult(sid, await sessionApi.answerTotp(sid, code), false);
    } catch (error) {
      reportFailure(error, t("containerFiles.totpFailed"));
    } finally {
      setIsConnecting(false);
    }
  };

  const handleBrowserContinue = async () => {
    if (!prompt || prompt.kind !== "browser") return;
    const sid = prompt.sessionId;
    setPrompt(null);
    setIsConnecting(true);
    try {
      applyConnectResult(
        sid,
        await sessionApi.continueBrowserSignIn(sid),
        false,
      );
    } catch (error) {
      reportFailure(error, t("containerFiles.browserSignInFailed"));
    } finally {
      setIsConnecting(false);
    }
  };

  const handlePromptCancel = () => {
    const sid = prompt?.sessionId;
    setPrompt(null);
    setIsConnecting(false);
    if (sid)
      sessionApi.disconnect(sid).catch(() => {
        // Closing is best effort; the backend drops idle sessions on its own.
      });
    onClose?.();
  };

  const handleAuthSubmit = async (credentials: {
    password?: string;
    sshKey?: string;
    keyPassword?: string;
  }) => {
    setShowAuthDialog(false);
    await connect({
      userProvidedPassword: credentials.password,
      userProvidedSshKey: credentials.sshKey,
      userProvidedKeyPassword: credentials.keyPassword,
    });
  };

  const handleRetry = () => {
    setBlocked(null);
    initializingRef.current = false;
    setSessionId(null);
    setConnected(false);
    clearLogs();
    setRetryCount((c) => c + 1);
  };

  const connectRetry = useConnectionRetry({
    connect: handleRetry,
    enabled: !prompt && !showAuthDialog,
    autoStart: false,
  });
  retryRef.current = connectRetry;

  const hostDetail = currentHost
    ? `${currentHost.username ? currentHost.username + "@" : ""}${currentHost.ip}:${currentHost.port}`
    : undefined;

  const dialogs = (
    <>
      <TOTPDialog
        isOpen={prompt?.kind === "totp"}
        prompt={prompt?.prompt ?? ""}
        mode={prompt?.isPassword ? "password" : "totp"}
        onSubmit={handleTotpSubmit}
        onCancel={handlePromptCancel}
      />
      <BrowserSignInDialog
        isOpen={prompt?.kind === "browser"}
        label={prompt?.label ?? ""}
        url={prompt?.url ?? ""}
        code={prompt?.code ?? ""}
        onContinue={handleBrowserContinue}
        onCancel={handlePromptCancel}
        onOpenUrl={() => {
          if (prompt?.url)
            window.open(prompt.url, "_blank", "noopener,noreferrer");
        }}
      />
      {currentHost && (
        <SSHAuthDialog
          isOpen={showAuthDialog}
          reason={authReason}
          onSubmit={handleAuthSubmit}
          onCancel={() => {
            setShowAuthDialog(false);
            setIsConnecting(false);
            onClose?.();
          }}
          hostInfo={{
            ip: currentHost.ip,
            port: currentHost.port,
            username: currentHost.username ?? "",
            name: currentHost.name,
          }}
        />
      )}
    </>
  );

  const wrapperStyle: React.CSSProperties = {
    opacity: isVisible ? 1 : 0,
    height: "100%",
    width: "100%",
  };
  const wrapperClass =
    "h-full w-full text-foreground overflow-hidden bg-transparent relative";

  if (blocked && !isConnecting && !connected) {
    return (
      <div style={wrapperStyle} className={wrapperClass}>
        <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="max-w-md text-sm text-muted-foreground">
            {t(`containerFiles.${blocked}`)}
          </p>
          <Button variant="outline" onClick={handleRetry}>
            {t("containerFiles.remoteRetry")}
          </Button>
        </div>
        {dialogs}
      </div>
    );
  }

  if (isConnecting || !connected) {
    return (
      <div style={wrapperStyle} className={wrapperClass}>
        <ConnectionScreen
          status={connectRetry.status}
          message={t("containerFiles.connecting")}
          detail={hostDetail}
          attempt={connectRetry.attempt}
          maxAttempts={connectRetry.maxAttempts}
          nextRetryInMs={connectRetry.nextRetryInMs}
          onManualRetry={connectRetry.retryNow}
          logPosition="top"
        />
        {dialogs}
      </div>
    );
  }

  if (selectedId && sessionId) {
    return (
      <div style={wrapperStyle} className={wrapperClass}>
        <PanelShell
          leading={
            <BackButton
              onClick={() => {
                setSelectedId(null);
                void refreshContainers();
              }}
              label={t("containers.back")}
            />
          }
          icon={<FolderArchive className="size-4" />}
          title={
            title
              ? `${t("containerFiles.title")} · ${title}`
              : t("containerFiles.title")
          }
          status={
            runtime
              ? t("containers.runtime", {
                  runtime: runtimeLabel(runtime, runtimeVersion),
                })
              : undefined
          }
          scroll={false}
          actions={<div ref={setActionsHost} className="flex items-center" />}
        >
          <ContainerWorkspace
            actionsHost={actionsHost}
            sessionId={sessionId}
            hostId={currentHost?.id ?? 0}
            containers={containers}
            initialContainerId={selectedId}
            isVisible={isVisible}
            onContainerState={(id, state) => state && patchContainer(id, state)}
            onChanged={handleChanged}
            onListNeeded={setPickerOpen}
            onEmpty={() => {
              setSelectedId(null);
              void refreshContainers();
            }}
          />
        </PanelShell>
        {dialogs}
      </div>
    );
  }

  const select = (id: string) => setSelectedId(id);

  return (
    <div style={wrapperStyle} className={wrapperClass}>
      <PanelShell
        icon={<Box className="size-4" />}
        title={
          title
            ? `${t("containerFiles.title")} · ${title}`
            : t("containerFiles.title")
        }
        status={
          runtime
            ? t("containers.runtime", {
                runtime: runtimeLabel(runtime, runtimeVersion),
              })
            : t("containerFiles.title")
        }
        actions={
          <Button
            variant="ghost"
            size="icon"
            onClick={refreshContainers}
            disabled={loading}
            title={t("containers.refresh")}
            className="text-accent-brand"
          >
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        }
        toolbar={
          <>
            <PanelSearch
              value={search}
              onChange={setSearch}
              placeholder={t("containers.searchPlaceholder")}
            />
            <Segmented
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: "all", label: t("containers.allStatuses") },
                { value: "running", label: t("containers.stateRunning") },
                { value: "paused", label: t("containers.statePaused") },
                { value: "exited", label: t("containers.stateExited") },
                { value: "restarting", label: t("containers.stateRestarting") },
              ]}
            />
            <div className="ml-auto flex items-center gap-2">
              <ViewToggle
                view={layout === "table" ? "list" : "grid"}
                onView={(next) => {
                  const value = next === "list" ? "table" : "card";
                  setLayout(value);
                  setPref("containerLayout", value);
                }}
                columns={columns}
                onColumns={(value) => {
                  setColumns(value);
                  setPref("containerColumns", value);
                }}
              />
            </div>
          </>
        }
        className="p-2.5 gap-2"
      >
        {!loadedOnce ? (
          <div className="flex flex-col items-center justify-center h-full opacity-40 py-20">
            <RefreshCw className="size-8 animate-spin mb-4" />
            <span className="text-sm font-semibold">
              {t("containers.loading")}
            </span>
          </div>
        ) : layout === "table" ? (
          <ContainerTable
            sessionId={sessionId!}
            onChanged={handleChanged}
            containers={containers}
            onSelectContainer={select}
            search={search}
            statusFilter={statusFilter}
          />
        ) : (
          <ContainerList
            sessionId={sessionId!}
            onChanged={handleChanged}
            containers={containers}
            columns={columns}
            onSelectContainer={select}
            search={search}
            statusFilter={statusFilter}
          />
        )}
      </PanelShell>
      {dialogs}
    </div>
  );
}

export function ContainerFilesTab({
  host,
  sshHost,
  label,
  isVisible,
}: TabProps): React.ReactElement {
  const record = (host ?? sshHost) as Record<string, unknown> | undefined;
  return (
    <ConnectionLogProvider>
      <ContainerFilesInner
        host={record ? toContainerHost(record) : undefined}
        rawHost={record}
        title={label}
        isVisible={isVisible}
      />
    </ConnectionLogProvider>
  );
}

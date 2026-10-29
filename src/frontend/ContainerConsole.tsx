import React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { pluginWsUrl } from "@termix-ssh/plugin-sdk/ui";
import type { Origin } from "./sessionOrigin";

/** A shell that ends sooner than this with an error did not start properly. */
export const STARTUP_MS = 3000;
const PING_MS = 25_000;

export interface ConsoleExit {
  code: number | null;
  /** The shell failed to start (no such shell, exec error). */
  early: boolean;
  idle?: boolean;
}

interface Props {
  sessionId: string;
  containerId: string;
  dir: string;
  shell: string;
  /** The origin of the session; the console socket opens on the same backend. */
  origin: Origin;
  isVisible: boolean;
  /** The shell failed to start; the caller offers another one. */
  onEarlyFailure: (message?: string) => void;
  /** The shell is still running after the startup grace period. */
  onStarted?: () => void;
  /** The backend says which shell it started. */
  onShell?: (shell: string) => void;
}

type Status = "connecting" | "running" | "ended";

function cssColor(el: HTMLElement, prop: "color" | "backgroundColor") {
  const value = getComputedStyle(el)[prop];
  return value && value !== "rgba(0, 0, 0, 0)" ? value : undefined;
}

/**
 * Only the container's shell: an xterm bound to the plugin's own console
 * WebSocket. There is no host terminal, banner or typed command; when the shell
 * exits the session ends and can be reopened.
 */
export function ContainerConsole({
  sessionId,
  containerId,
  dir,
  shell,
  origin,
  isVisible,
  onEarlyFailure,
  onStarted,
  onShell,
}: Props): React.ReactElement {
  const { t } = useTranslation();
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [status, setStatus] = React.useState<Status>("connecting");
  const [notice, setNotice] = React.useState<string | null>(null);
  const [run, setRun] = React.useState(0);
  const callbacks = React.useRef({ onEarlyFailure, onStarted, onShell });
  callbacks.current = { onEarlyFailure, onStarted, onShell };
  const fitRef = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    setStatus("connecting");
    setNotice(null);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily:
        '"JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace',
      scrollback: 5000,
      theme: {
        background: cssColor(host, "backgroundColor"),
        foreground: cssColor(host, "color"),
        cursor: cssColor(host, "color"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);

    let ws: WebSocket | null = null;
    let ping: ReturnType<typeof setInterval> | undefined;
    let startedTimer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;

    const send = (type: string, data?: unknown) => {
      if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type, data }));
    };
    const doFit = () => {
      try {
        fit.fit();
      } catch {
        // the window is not laid out yet
      }
      send("resize", { cols: term.cols, rows: term.rows });
    };
    fitRef.current = doFit;

    const finish = (message?: string) => {
      if (ended) return;
      ended = true;
      clearTimeout(startedTimer);
      clearInterval(ping);
      setNotice(message ?? null);
      setStatus("ended");
    };

    const input = term.onData((data) => send("input", data));

    void (async () => {
      try {
        const target = await pluginWsUrl("container-files", "/console", {
          origin,
        });
        if (disposed) return;
        if (!target) {
          finish(t("containerFiles.consoleNoConnection"));
          return;
        }
        ws = new WebSocket(target.url, target.protocols);
        ws.onopen = () => {
          try {
            fit.fit();
          } catch {
            // ignore
          }
          send("connect", {
            sessionId,
            containerId,
            dir,
            shell,
            cols: term.cols,
            rows: term.rows,
          });
          ping = setInterval(() => send("ping"), PING_MS);
        };
        ws.onmessage = (event) => {
          let msg: {
            type?: string;
            data?: unknown;
            message?: string;
          };
          try {
            msg = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (msg.type === "output" && typeof msg.data === "string") {
            term.write(msg.data);
          } else if (msg.type === "connected") {
            const info = (msg.data ?? {}) as { shell?: unknown };
            if (typeof info.shell === "string" && info.shell)
              callbacks.current.onShell?.(info.shell);
            setStatus("running");
            term.focus();
            startedTimer = setTimeout(
              () => callbacks.current.onStarted?.(),
              STARTUP_MS,
            );
          } else if (msg.type === "exit") {
            const exit = (msg.data ?? {}) as ConsoleExit;
            if (exit.early) {
              ended = true;
              clearTimeout(startedTimer);
              clearInterval(ping);
              callbacks.current.onEarlyFailure(
                t("containerFiles.terminalExited", { shell }),
              );
              return;
            }
            finish(exit.idle ? t("containerFiles.consoleIdle") : undefined);
          } else if (msg.type === "error") {
            finish(msg.message);
          }
        };
        ws.onclose = () => finish(t("containerFiles.consoleClosed"));
        ws.onerror = () => finish(t("containerFiles.consoleClosed"));
      } catch {
        if (!disposed) finish(t("containerFiles.consoleNoConnection"));
      }
    })();

    const observer = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) doFit();
    });
    observer.observe(host);

    return () => {
      disposed = true;
      ended = true;
      fitRef.current = null;
      observer.disconnect();
      clearTimeout(startedTimer);
      clearInterval(ping);
      input.dispose();
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "disconnect" }));
          }
          ws.close();
        } catch {
          // already closed
        }
      }
      term.dispose();
    };
    // The terminal is rebuilt only when the person reopens it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  React.useEffect(() => {
    if (isVisible) fitRef.current?.();
  }, [isVisible]);

  return (
    <div className="relative h-full w-full bg-background text-foreground">
      <div ref={hostRef} className="h-full w-full p-1" />
      {status === "connecting" && (
        <div className="pointer-events-none absolute left-2 top-2 text-[11px] text-muted-foreground">
          {t("containerFiles.consoleConnecting")}
        </div>
      )}
      {status === "ended" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/85 p-4 text-center">
          <p className="text-sm font-medium">
            {t("containerFiles.consoleEnded")}
          </p>
          {notice && (
            <p className="max-w-md text-xs text-muted-foreground">{notice}</p>
          )}
          <button
            type="button"
            className="border border-border px-3 py-1.5 text-xs hover:bg-muted/40"
            onClick={() => setRun((n) => n + 1)}
          >
            {t("containerFiles.consoleReopen")}
          </button>
        </div>
      )}
    </div>
  );
}

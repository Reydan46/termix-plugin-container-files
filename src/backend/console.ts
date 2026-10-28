// The container console: a WebSocket at /plugin-ws/container-files/console that
// runs `docker exec -it -w <dir> <container> <shell>` on an ssh2 exec channel
// with a pty. The person sees only the container's shell: no host banner, no
// host prompt and no typed command, and the session ends when the shell exits.

import { StringDecoder } from "node:string_decoder";
import type { ClientChannel } from "ssh2";
import type {
  PluginContext,
  PluginWebSocketConnection,
} from "@termix-ssh/plugin-sdk/backend";
import {
  AUTO_SHELL,
  buildConsoleCommand,
  isShellPath,
} from "./console-command.js";
import { runCommand } from "./exec.js";
import { engineCommand } from "./shell-quote.js";
import {
  CONTAINER_ID_RE,
  getErrorMessage,
  HttpError,
  type Logger,
} from "./helpers.js";
import type { ContainerSession, Sessions } from "./sessions.js";

const WS_OPEN = 1;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_INPUT_CHARS = 64 * 1024;
const PING_MS = 30_000;
/** A console nobody typed into for this long is closed. */
export const CONSOLE_IDLE_MS = 30 * 60 * 1000;
/** A shell that exits sooner than this with an error did not start properly. */
export const STARTUP_MS = 3000;

/** How long the probe for the auto shell may take. */
const PROBE_MS = 5000;

/** The part of a `ws` WebSocket that the console uses. */
export interface ConsoleSocket {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  ping?: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

interface ConsoleDeps {
  ctx: Pick<PluginContext, "rbac">;
  sessions: Sessions;
  log: Logger;
}

function toDimension(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : fallback;
}

function parseFrame(raw: unknown): { type: string; data: unknown } {
  const text = Array.isArray(raw)
    ? Buffer.concat(raw as Buffer[]).toString("utf8")
    : Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw).toString("utf8")
        : String(raw);
  if (text.length > MAX_FRAME_BYTES) throw new Error("Message too large");
  const message = JSON.parse(text) as unknown;
  if (!message || typeof message !== "object")
    throw new Error("Invalid message");
  const { type, data } = message as { type?: unknown; data?: unknown };
  if (typeof type !== "string") throw new Error("Invalid message");
  return { type, data };
}

/** Handles one console socket. Exported for tests. */
export function createConsoleHandler({ ctx, sessions, log }: ConsoleDeps) {
  const live = new Set<() => void>();

  const handler = async (
    connection: Pick<
      PluginWebSocketConnection,
      "userId" | "socket" | "isDataUnlocked"
    >,
  ): Promise<void> => {
    const ws = connection.socket as ConsoleSocket;
    const userId = connection.userId;
    if (!userId || !(await ctx.rbac.hasFor(userId, "use"))) {
      ws.close(1008, "Authentication required");
      return;
    }

    interface Running {
      session: ContainerSession;
      stream: ClientChannel;
      idle: ReturnType<typeof setTimeout>;
    }
    let running: Running | null = null;
    // Bumped by every connect and disconnect so a slow connect that lost the
    // race does not start a shell nobody listens to.
    let attempt = 0;
    let closed = false;

    const send = (message: Record<string, unknown>) => {
      if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(message));
    };

    const endShell = () => {
      if (!running) return;
      const current = running;
      running = null;
      clearTimeout(current.idle);
      current.session.activeOperations--;
      try {
        current.stream.end();
        current.stream.close?.();
      } catch {
        // already closed
      }
    };

    const armIdle = (current: Running) => {
      clearTimeout(current.idle);
      current.idle = setTimeout(() => {
        if (running !== current) return;
        send({ type: "exit", data: { code: null, early: false, idle: true } });
        endShell();
      }, CONSOLE_IDLE_MS);
      current.idle.unref?.();
    };

    const pingTimer = setInterval(() => {
      if (ws.readyState === WS_OPEN) ws.ping?.();
    }, PING_MS);
    pingTimer.unref?.();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      attempt++;
      clearInterval(pingTimer);
      endShell();
      live.delete(shutdown);
    };
    const shutdown = () => {
      cleanup();
      try {
        ws.close(1001, "Plugin disabled");
      } catch {
        // already closed
      }
    };
    live.add(shutdown);

    const connect = (data: unknown) => {
      const mine = ++attempt;
      endShell();
      if (!connection.isDataUnlocked()) {
        send({
          type: "error",
          message: "Session expired - please log in again",
        });
        return;
      }
      const payload = (data && typeof data === "object" ? data : {}) as Record<
        string,
        unknown
      >;
      const sessionId = String(payload.sessionId ?? "");
      const containerId = String(payload.containerId ?? "");
      if (!sessionId || !CONTAINER_ID_RE.test(containerId)) {
        send({ type: "error", message: "Invalid container" });
        return;
      }
      if (sessions.getPending(sessionId)) {
        send({
          type: "error",
          message: "Connection pending authentication",
          code: "AUTH_PENDING",
        });
        return;
      }
      const session = sessions.get(sessionId, userId);
      if (!session) {
        send({
          type: "error",
          message: "SSH session not found or not connected",
          code: "NO_SESSION",
        });
        return;
      }
      const requested = payload.shell ?? AUTO_SHELL;
      const dir = payload.dir ?? "/";
      let command: string;
      try {
        command = buildConsoleCommand({
          runtime: session.runtime,
          containerId,
          dir,
          shell: requested,
        });
      } catch (error) {
        send({
          type: "error",
          message:
            error instanceof HttpError
              ? error.message
              : getErrorMessage(error, "Invalid request"),
        });
        return;
      }
      const cols = toDimension(payload.cols, 80);
      const rows = toDimension(payload.rows, 24);

      sessions.touch(session);
      if (requested !== AUTO_SHELL) {
        start(session, command, String(requested), mine, cols, rows);
        return;
      }
      // Auto: find out which shell will run, so the person can be told.
      session.activeOperations++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        session.activeOperations--;
      };
      void probeShell(session, containerId)
        .then((found) => {
          release();
          if (mine !== attempt || closed) return;
          let chosen: string | null = null;
          if (found) {
            try {
              command = buildConsoleCommand({
                runtime: session.runtime,
                containerId,
                dir,
                shell: found,
              });
              chosen = found;
            } catch {
              // keep the fallback script
            }
          }
          start(session, command, chosen, mine, cols, rows);
        })
        .catch(() => {
          release();
        });
    };

    /** The shell that `auto` resolves to (bash, else sh), or null. */
    const probeShell = async (
      session: ContainerSession,
      containerId: string,
    ): Promise<string | null> => {
      try {
        const result = await runCommand(
          session.client,
          engineCommand(session.runtime, [
            "exec",
            containerId,
            "sh",
            "-c",
            "command -v bash || command -v sh",
          ]),
          { timeoutMs: PROBE_MS, maxBytes: 4096 },
        );
        const line = result.stdout.toString("utf8").split("\n")[0]?.trim();
        return result.code === 0 && line && isShellPath(line) ? line : null;
      } catch {
        return null;
      }
    };

    const start = (
      session: ContainerSession,
      command: string,
      shell: string | null,
      mine: number,
      cols: number,
      rows: number,
    ) => {
      session.activeOperations++;
      let registered = false;
      const startedAt = Date.now();
      try {
        session.client.exec(
          command,
          { pty: { term: "xterm-256color", cols, rows } },
          (err, stream) => {
            if (err || !stream) {
              session.activeOperations--;
              send({
                type: "error",
                message: `Failed to start the console: ${getErrorMessage(err, "no channel")}`,
              });
              return;
            }
            if (mine !== attempt || closed) {
              session.activeOperations--;
              stream.end();
              stream.close();
              return;
            }
            const current: Running = {
              session,
              stream,
              idle: setTimeout(() => {}, 0),
            };
            running = current;
            registered = true;
            armIdle(current);

            // Chunks can split a multi-byte UTF-8 sequence.
            const decoder = new StringDecoder("utf-8");
            stream.on("data", (chunk: Buffer) => {
              const text = decoder.write(chunk);
              if (text) send({ type: "output", data: text });
            });
            stream.stderr?.on("data", () => {});
            stream.stderr?.on("error", () => {});
            stream.on("error", (streamError: Error) => {
              send({
                type: "error",
                message: `Console error: ${streamError.message}`,
              });
            });
            stream.on("close", (code: number | null | undefined) => {
              const exitCode = typeof code === "number" ? code : null;
              const early =
                Date.now() - startedAt < STARTUP_MS &&
                exitCode !== null &&
                exitCode !== 0;
              if (running === current) {
                send({ type: "exit", data: { code: exitCode, early } });
                endShell();
              }
            });
            send({ type: "connected", data: { shell } });
          },
        );
      } catch (error) {
        if (!registered) session.activeOperations--;
        log.error("Failed to start the container console", error, {
          hostId: session.hostId,
        });
        send({
          type: "error",
          message: getErrorMessage(error, "Failed to start the console"),
        });
      }
    };

    ws.on("message", (raw: unknown) => {
      let frame: { type: string; data: unknown };
      try {
        frame = parseFrame(raw);
      } catch (error) {
        send({ type: "error", message: getErrorMessage(error) });
        return;
      }
      switch (frame.type) {
        case "connect":
          connect(frame.data);
          break;
        case "input": {
          const input = frame.data;
          if (
            running &&
            typeof input === "string" &&
            input.length > 0 &&
            input.length <= MAX_INPUT_CHARS
          ) {
            running.stream.write(input);
            sessions.touch(running.session);
            armIdle(running);
          }
          break;
        }
        case "resize": {
          const size = (frame.data ?? {}) as Record<string, unknown>;
          const cols = toDimension(size.cols, 0);
          const rows = toDimension(size.rows, 0);
          if (running && cols && rows)
            running.stream.setWindow(rows, cols, rows, cols);
          break;
        }
        case "disconnect":
          attempt++;
          endShell();
          break;
        case "ping":
          send({ type: "pong" });
          break;
        default:
          log.warn("Unknown console message", { type: frame.type });
      }
    });
    ws.on("close", cleanup);
    ws.on("error", (error: unknown) => {
      log.error("Console socket error", error);
      cleanup();
    });
  };

  return { handler, closeAll: () => [...live].forEach((end) => end()) };
}

/**
 * Registers the console route. The route is not public, so core
 * authenticates the upgrade; the handler still checks container-files.use.
 */
export function registerConsole(ctx: PluginContext, deps: ConsoleDeps): void {
  const { handler, closeAll } = createConsoleHandler(deps);
  ctx.disposables.add(closeAll);
  ctx.ws.route("/console", (connection) => handler(connection));
}

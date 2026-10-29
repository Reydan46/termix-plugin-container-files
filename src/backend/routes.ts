import type { Request, Response, Router } from "express";
import type {
  PluginContext,
  PluginSshHost,
} from "@termix-ssh/plugin-sdk/backend";
import { OpProgressRegistry } from "./op-progress.js";
import { appendToArchive } from "./archive-append.js";
import { deleteFromArchive } from "./archive-delete.js";
import {
  extractPlanItems,
  extractWithPolicy,
  parseExtractPolicy,
} from "./extract-policy.js";
import { answerConnect, startConnect } from "./connect.js";
import { getCapabilities } from "./capabilities.js";
import { duBytes } from "./c2c.js";
import {
  getContainerState,
  invalidateContainerState,
  isContainerAction,
  listContainers,
  runContainerAction,
} from "./containers.js";
import { readPrincipals } from "./principals.js";
import { listShells } from "./shells.js";
import { getMounts } from "./mounts.js";
import { listDirectory, type ListTarget } from "./fs-list.js";
import {
  CONTAINER_ID_RE,
  connectionLog,
  getErrorMessage,
  HttpError,
  type ConnectionLogLine,
  type Logger,
} from "./helpers.js";
import {
  changeMode,
  changeOwner,
  parseScope,
  compress,
  copyPath,
  createFile,
  deletePaths,
  extract,
  makeDirectory,
  makeSymlink,
  movePath,
  sha256,
  statPath,
  type ArchiveFormat,
} from "./fs-ops.js";
import {
  readTextFile,
  writeTextFile,
  EDITOR_MAX_BYTES,
} from "./fs-read-write.js";
import { safeName, safePath } from "./shell-quote.js";
import {
  contentDisposition,
  download,
  upload,
  type TransferRegistry,
} from "./transfers.js";
import {
  dropArchiveCache,
  extractArchiveEntries,
  innerPath,
  listArchive,
  readArchiveEntry,
} from "./archive.js";
import type { ContainerSession, Sessions } from "./sessions.js";
import { createRemoteProxy } from "./remote-proxy.js";
import { registerTransferExtra } from "./routes-transfer-extra.js";

const LIST_CHUNK = 500;

/** The `size` query of an upload, or undefined when absent or invalid. */
function sizeParam(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return undefined;
  return Number(value);
}
const LIST_CACHE_TTL_MS = 5000;

interface Deps {
  ctx: PluginContext;
  sessions: Sessions;
  log: Logger;
  transfers: TransferRegistry;
}

export function registerRoutes(
  router: Router,
  { ctx, sessions, log, transfers }: Deps,
) {
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(ctx.rbac.require("use") as never);

  /**
   * @openapi
   * /plugin-api/container-files/remote/{path}:
   *   get:
   *     summary: "Proxy a request to the linked server (desktop only)"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: path, in: path, required: true, schema: { type: string }, description: "A route under ssh/, containers/, transfers/ or operations/" }
   *     responses:
   *       200:
   *         description: "The server's reply, streamed as it arrives"
   *       400:
   *         description: "The path is not one of the proxied routes"
   *       401:
   *         description: "Not signed in here, or the link to the server is signed out"
   *       404:
   *         description: "Not the desktop app"
   *       502:
   *         description: "The server cannot be reached"
   */
  router.use("/remote", createRemoteProxy(ctx));

  const opProgress = new OpProgressRegistry();

  const userOf = (res: Response): string | null => {
    const userId = ctx.currentActor();
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    return userId;
  };

  const sessionOf = (req: Request, res: Response): ContainerSession | null => {
    const userId = userOf(res);
    if (!userId) return null;
    const sessionId = String(req.params.sessionId ?? "");
    if (sessions.getPending(sessionId)) {
      res.status(400).json({
        error: "Connection pending authentication",
        code: "AUTH_PENDING",
      });
      return null;
    }
    const session = sessions.get(sessionId, userId);
    if (!session) {
      res.status(400).json({
        error: "SSH session not found or not connected",
        code: "NO_SESSION",
      });
      return null;
    }
    return session;
  };

  /** Aborts when the client goes away, so stale requests stop their commands. */
  const abortOnClose = (req: Request, res: Response): AbortSignal => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    req.on("aborted", () => controller.abort());
    return controller.signal;
  };

  const fail = (res: Response, error: unknown, what: string) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({
        error: error.message,
        code: error.code,
        ...(error.details ? { details: error.details } : {}),
      });
      return;
    }
    log.error(what, error);
    res.status(500).json({ error: getErrorMessage(error, what) });
  };

  /**
   * @openapi
   * /plugin-api/container-files/ssh/connect:
   *   post:
   *     summary: "Open an SSH session to a saved host"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [sessionId, hostId]
   *             properties:
   *               sessionId: { type: string }
   *               hostId: { type: integer }
   *               userProvidedPassword: { type: string }
   *               userProvidedSshKey: { type: string }
   *               userProvidedKeyPassword: { type: string }
   *     responses:
   *       200:
   *         description: "Connected, or the next login step, with connectionLogs"
   *       400:
   *         description: "sessionId or hostId missing"
   *       404:
   *         description: "Host not found"
   *       500:
   *         description: "Connection error"
   */
  router.post("/ssh/connect", async (req, res) => {
    const userId = userOf(res);
    if (!userId) return;
    const {
      sessionId,
      hostId,
      userProvidedPassword,
      userProvidedSshKey,
      userProvidedKeyPassword,
    } = (req.body ?? {}) as Record<string, unknown>;
    const logs: ConnectionLogLine[] = [];

    if (typeof sessionId !== "string" || !sessionId || !hostId) {
      logs.push(
        connectionLog("error", "connecting", "Missing connection parameters"),
      );
      return res
        .status(400)
        .json({ error: "Missing sessionId or hostId", connectionLogs: logs });
    }
    const numericHostId = Number(hostId);
    logs.push(connectionLog("info", "connecting", "Initiating SSH connection"));

    try {
      const host = await ctx.ssh.resolveHost(numericHostId);
      if (!host) {
        logs.push(connectionLog("error", "connecting", "Host not found"));
        return res
          .status(404)
          .json({ error: "Host not found", connectionLogs: logs });
      }

      sessions.close(sessionId);
      logs.push(
        connectionLog("info", "auth", "Resolving authentication credentials"),
      );

      const hasAuthOverride = [
        userProvidedPassword,
        userProvidedSshKey,
        userProvidedKeyPassword,
      ].some((value) => typeof value === "string" && value.length > 0);
      // Core associates the redacted host object with its stored credentials.
      const target: PluginSshHost = hasAuthOverride ? { ...host } : host;
      if (typeof userProvidedPassword === "string" && userProvidedPassword) {
        target.password = userProvidedPassword;
        target.authType = "password";
      }
      if (typeof userProvidedSshKey === "string" && userProvidedSshKey) {
        target.key = userProvidedSshKey;
        target.authType = "key";
      }
      if (
        typeof userProvidedKeyPassword === "string" &&
        userProvidedKeyPassword
      ) {
        target.keyPassword = userProvidedKeyPassword;
      }

      const step = await startConnect(ctx, sessions, log, {
        sessionId,
        userId,
        host: target,
        logs,
      });
      return res.status(step.status).json(step.body);
    } catch (error) {
      log.error("SSH connection error", error, {
        hostId: numericHostId,
        userId,
      });
      logs.push(
        connectionLog(
          "error",
          "connecting",
          `Connection error: ${getErrorMessage(error)}`,
        ),
      );
      return res.status(500).json({
        success: false,
        message: getErrorMessage(error),
        connectionLogs: logs,
      });
    }
  });

  /**
   * @openapi
   * /plugin-api/container-files/ssh/connect-totp:
   *   post:
   *     summary: "Submit a TOTP code for a pending connection"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [sessionId, totpCode]
   *             properties:
   *               sessionId: { type: string }
   *               totpCode: { type: string }
   *     responses:
   *       200:
   *         description: "Result of the connection step"
   *       400:
   *         description: "sessionId or totpCode missing"
   */
  router.post("/ssh/connect-totp", async (req, res) => {
    const userId = userOf(res);
    if (!userId) return;
    const { sessionId, totpCode } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof sessionId !== "string" || typeof totpCode !== "string") {
      return res
        .status(400)
        .json({ error: "Session ID and TOTP code required" });
    }
    const step = await answerConnect(
      sessions,
      sessionId,
      userId,
      "totp",
      totpCode.trim(),
    );
    return res.status(step.status).json(step.body);
  });

  /**
   * @openapi
   * /plugin-api/container-files/ssh/connect-browser-sign-in:
   *   post:
   *     summary: "Confirm browser sign-in for a pending connection"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [sessionId]
   *             properties:
   *               sessionId: { type: string }
   *     responses:
   *       200:
   *         description: "Result of the connection step"
   *       400:
   *         description: "sessionId missing"
   */
  router.post("/ssh/connect-browser-sign-in", async (req, res) => {
    const userId = userOf(res);
    if (!userId) return;
    const { sessionId } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof sessionId !== "string" || !sessionId) {
      return res.status(400).json({ error: "Session ID is required" });
    }
    const step = await answerConnect(
      sessions,
      sessionId,
      userId,
      "browser",
      "",
    );
    return res.status(step.status).json(step.body);
  });

  /**
   * @openapi
   * /plugin-api/container-files/ssh/disconnect:
   *   post:
   *     summary: "Close an SSH session"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [sessionId]
   *             properties:
   *               sessionId: { type: string }
   *     responses:
   *       200:
   *         description: "Session closed (success is true even if it was already gone)"
   *       400:
   *         description: "sessionId missing"
   */
  router.post("/ssh/disconnect", (req, res) => {
    const userId = userOf(res);
    if (!userId) return;
    const { sessionId } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof sessionId !== "string" || !sessionId) {
      return res.status(400).json({ error: "Session ID is required" });
    }
    const pending = sessions.getPending(sessionId);
    if (sessions.get(sessionId, userId) || pending?.userId === userId) {
      sessions.close(sessionId);
    }
    return res.json({ success: true });
  });

  /**
   * @openapi
   * /plugin-api/container-files/ssh/keepalive:
   *   post:
   *     summary: "Refresh the idle timer of an SSH session"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [sessionId]
   *             properties:
   *               sessionId: { type: string }
   *     responses:
   *       200:
   *         description: "Session is connected; returns lastActive"
   *       400:
   *         description: "sessionId missing, or session not found or not connected"
   */
  router.post("/ssh/keepalive", (req, res) => {
    const userId = userOf(res);
    if (!userId) return;
    const { sessionId } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof sessionId !== "string" || !sessionId) {
      return res.status(400).json({ error: "Session ID is required" });
    }
    const session = sessions.get(sessionId, userId);
    if (!session) {
      return res.status(400).json({
        error: "SSH session not found or not connected",
        connected: false,
      });
    }
    sessions.touch(session);
    return res.json({
      success: true,
      connected: true,
      lastActive: session.lastActive,
    });
  });

  /**
   * @openapi
   * /plugin-api/container-files/ssh/status:
   *   get:
   *     summary: "Report whether an SSH session is connected"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: query, required: true, schema: { type: string } }
   *     responses:
   *       200:
   *         description: "connected flag, plus runtime and runtimeVersion when connected"
   *       400:
   *         description: "sessionId missing"
   */
  router.get("/ssh/status", (req, res) => {
    const userId = userOf(res);
    if (!userId) return;
    const sessionId = req.query.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      return res.status(400).json({ error: "Session ID is required" });
    }
    const session = sessions.get(sessionId, userId);
    return res.json({
      success: true,
      connected: !!session,
      runtime: session?.runtime,
      runtimeVersion: session?.runtimeVersion,
    });
  });

  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}:
   *   get:
   *     summary: "List containers on the SSH session host"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *     responses:
   *       200:
   *         description: "Container runtime and container list"
   *       400:
   *         description: "Session not found, or pending authentication"
   *       500:
   *         description: "Listing failed"
   */
  router.get("/containers/:sessionId", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const signal = abortOnClose(req, res);
    try {
      const containers = await sessions.run(session, () =>
        listContainers(session.client, session.runtime, signal),
      );
      res.json({ runtime: session.runtime, containers });
    } catch (error) {
      fail(res, error, "Failed to list containers");
    }
  });

  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}/{containerId}/capabilities:
   *   get:
   *     summary: "Probe which file features a container supports"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *       - { name: containerId, in: path, required: true, schema: { type: string } }
   *     responses:
   *       200:
   *         description: "Capability flags for the container"
   *       400:
   *         description: "Session not found, or pending authentication"
   *       500:
   *         description: "Probe failed"
   */
  router.get(
    "/containers/:sessionId/:containerId/capabilities",
    async (req, res) => {
      const session = sessionOf(req, res);
      if (!session) return;
      const signal = abortOnClose(req, res);
      try {
        const caps = await sessions.run(session, () =>
          getCapabilities(session, req.params.containerId, signal, {
            fresh: true,
          }),
        );
        res.json(caps);
      } catch (error) {
        fail(res, error, "Failed to probe container");
      }
    },
  );

  /** Lightweight, always-fresh state for polling: one `inspect`. */
  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}/{containerId}/state:
   *   get:
   *     summary: "Read a container's current running state"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *       - { name: containerId, in: path, required: true, schema: { type: string } }
   *     responses:
   *       200:
   *         description: "id, name, running, state and capabilities"
   *       400:
   *         description: "Session not found, or pending authentication"
   *       500:
   *         description: "Read failed"
   */
  router.get("/containers/:sessionId/:containerId/state", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const signal = abortOnClose(req, res);
    try {
      const payload = await sessions.run(session, async () => {
        const state = await getContainerState(session, req.params.containerId, {
          fresh: true,
          signal,
        });
        const capabilities = await getCapabilities(
          session,
          req.params.containerId,
          signal,
        );
        return {
          id: state.id,
          name: state.name,
          running: state.running,
          state: state.status,
          capabilities,
        };
      });
      res.json(payload);
    } catch (error) {
      fail(res, error, "Failed to read container state");
    }
  });

  /** Shells usable for a terminal in the container; never fails on exec problems. */
  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}/{containerId}/shells:
   *   get:
   *     summary: "List shells usable in a container"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *       - { name: containerId, in: path, required: true, schema: { type: string } }
   *     responses:
   *       200:
   *         description: "shells and default shell (empty list when exec fails)"
   *       400:
   *         description: "Invalid container ID, or session not found"
   *       500:
   *         description: "Read failed"
   */
  router.get("/containers/:sessionId/:containerId/shells", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const signal = abortOnClose(req, res);
    const { containerId } = req.params;
    if (!CONTAINER_ID_RE.test(containerId)) {
      return res.status(400).json({ error: "Invalid container ID" });
    }
    try {
      const info = await sessions.run(session, async () => {
        try {
          return await listShells(
            await targetOf(session, containerId, signal),
            signal,
          );
        } catch (error) {
          if (signal.aborted) throw error;
          return { shells: [], default: null };
        }
      });
      return res.json(info);
    } catch (error) {
      return fail(res, error, "Failed to read shells");
    }
  });

  /** Mounts of the container; an engine that cannot report them gives an empty list. */
  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}/{containerId}/mounts:
   *   get:
   *     summary: "List the mounts of a container"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *       - { name: containerId, in: path, required: true, schema: { type: string } }
   *     responses:
   *       200:
   *         description: "mounts: type (bind, volume or tmpfs), source, destination, readOnly and name (volumes); empty when the engine reports none"
   *       400:
   *         description: "Invalid container ID, or session not found"
   *       404:
   *         description: "Container not found"
   *       500:
   *         description: "Read failed"
   */
  router.get("/containers/:sessionId/:containerId/mounts", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const signal = abortOnClose(req, res);
    try {
      const mounts = await sessions.run(session, async () => {
        await getContainerState(session, req.params.containerId, { signal });
        return getMounts(session, req.params.containerId, signal);
      });
      res.json({ mounts });
    } catch (error) {
      fail(res, error, "Failed to read mounts");
    }
  });

  const listCache = new Map<
    string,
    { at: number; payload: Awaited<ReturnType<typeof listDirectory>> }
  >();

  /** NDJSON: {meta}, then {entries: [...]} chunks, then {done}. */
  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}/{containerId}/fs/list:
   *   get:
   *     summary: "List a directory inside a container"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *       - { name: containerId, in: path, required: true, schema: { type: string } }
   *       - { name: path, in: query, required: false, schema: { type: string, default: "/" } }
   *     responses:
   *       200:
   *         description: "NDJSON stream: a meta line, entry chunks, then a done line"
   *       400:
   *         description: "Session not found, or invalid path"
   *       500:
   *         description: "Listing failed"
   */
  router.get(
    "/containers/:sessionId/:containerId/fs/list",
    async (req, res) => {
      const session = sessionOf(req, res);
      if (!session) return;
      const signal = abortOnClose(req, res);
      try {
        const dir = safePath(req.query.path ?? "/");
        const { containerId } = req.params;
        const result = await sessions.run(session, async () => {
          const state = await getContainerState(session, containerId, {
            signal,
          });
          const capabilities = await getCapabilities(
            session,
            containerId,
            signal,
          );
          const key = `${session.id}\0${state.id}\0${dir}\0${state.running}`;
          const hit = listCache.get(key);
          if (hit && Date.now() - hit.at < LIST_CACHE_TTL_MS)
            return hit.payload;
          const target: ListTarget = {
            client: session.client,
            runtime: session.runtime,
            containerId,
            capabilities,
          };
          const payload = await listDirectory(target, dir, signal);
          listCache.set(key, { at: Date.now(), payload });
          if (listCache.size > 200) {
            const oldest = listCache.keys().next().value;
            if (oldest !== undefined) listCache.delete(oldest);
          }
          return payload;
        });

        // Half-finished uploads live under a temporary name; don't show them.
        const entries = result.entries.filter(
          (e) => !e.name.startsWith(".cf-part-"),
        );
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.write(
          `${JSON.stringify({
            meta: {
              path: result.path,
              tier: result.tier,
              truncated: result.truncated,
              total: entries.length,
            },
          })}\n`,
        );
        for (let i = 0; i < entries.length; i += LIST_CHUNK) {
          res.write(
            `${JSON.stringify({ entries: entries.slice(i, i + LIST_CHUNK) })}\n`,
          );
        }
        res.end(`${JSON.stringify({ done: true })}\n`);
      } catch (error) {
        fail(res, error, "Failed to list directory");
      }
    },
  );

  const base = "/containers/:sessionId/:containerId";

  const targetOf = async (
    session: ContainerSession,
    containerId: string,
    signal: AbortSignal,
  ): Promise<ListTarget> => {
    await getContainerState(session, containerId, { signal });
    const capabilities = await getCapabilities(session, containerId, signal);
    return {
      client: session.client,
      runtime: session.runtime,
      containerId,
      capabilities,
    };
  };

  const dropListings = (session: ContainerSession) => {
    dropArchiveCache(session.client);
    for (const key of listCache.keys()) {
      if (key.startsWith(`${session.id}\0`)) listCache.delete(key);
    }
  };

  const audit = (
    session: ContainerSession,
    action: string,
    containerId: string,
    detail: string,
  ) => {
    void ctx.audit.record({
      action: `container_files_${action}`,
      resourceType: "host",
      resourceId: String(session.hostId),
      resourceName: `${containerId}:${detail}`.slice(0, 250),
      success: true,
    });
  };

  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}/{containerId}/action:
   *   post:
   *     summary: "Start, stop, restart, pause or unpause a container"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *       - { name: containerId, in: path, required: true, schema: { type: string } }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [action]
   *             properties:
   *               action: { type: string, enum: [start, stop, restart, pause, unpause] }
   *     responses:
   *       200:
   *         description: "success, plus the container id, name, running, state and capabilities"
   *       400:
   *         description: "Invalid action, or session not found"
   *       500:
   *         description: "Action failed"
   */
  router.post(`${base}/action`, async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const signal = abortOnClose(req, res);
    const { containerId } = req.params;
    try {
      const action = (req.body as Record<string, unknown> | undefined)?.action;
      if (!isContainerAction(action)) {
        throw new HttpError(400, "Invalid action");
      }
      const payload = await sessions.run(session, async () => {
        let state;
        try {
          state = await runContainerAction(
            session,
            containerId,
            action,
            signal,
          );
        } finally {
          invalidateContainerState(session, containerId);
          dropListings(session);
        }
        const capabilities = await getCapabilities(
          session,
          containerId,
          signal,
        );
        return {
          success: true,
          id: state.id,
          name: state.name,
          running: state.running,
          state: state.status,
          capabilities,
        };
      });
      audit(session, `container_${action}`, containerId, action);
      res.json(payload);
    } catch (error) {
      fail(res, error, "Container action failed");
    }
  });

  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}/{containerId}/fs/principals:
   *   get:
   *     summary: "List users and groups in a container"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *       - { name: containerId, in: path, required: true, schema: { type: string } }
   *     responses:
   *       200:
   *         description: "Users and groups found in the container"
   *       400:
   *         description: "Session not found, or pending authentication"
   *       500:
   *         description: "Read failed"
   */
  router.get(`${base}/fs/principals`, async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const signal = abortOnClose(req, res);
    try {
      const principals = await sessions.run(session, async () => {
        const t = await targetOf(session, req.params.containerId, signal);
        return readPrincipals(t, signal);
      });
      res.json(principals);
    } catch (error) {
      fail(res, error, "Failed to read users and groups");
    }
  });

  const bodyOf = (req: Request): Record<string, unknown> =>
    (req.body ?? {}) as Record<string, unknown>;
  const flag = (value: unknown) =>
    value === true || value === "1" || value === 1;

  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}/{containerId}/fs/{op}:
   *   post:
   *     summary: "Run a file operation in a container"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *       - { name: containerId, in: path, required: true, schema: { type: string } }
   *       - { name: op, in: path, required: true, schema: { type: string, enum: [mkdir, create, rename, move, copy, delete, chmod, chown, symlink, compress, append, extract, extract-entries, extract-plan, archive-delete, sha256, du] } }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             description: "Fields depend on op: path (mkdir, create, chmod, chown, symlink, sha256), from and to (rename, move, copy), paths (delete, du), overwrite, recursive, mode, owner, scope, target and force (symlink), dir, names, out and format (compress), archive, dest and entries (extract, extract-entries; skip and renames in place of overwrite when some names already exist: names to leave out and name -> new name; the extraction is staged and then placed), archive and entries (extract-plan: answers data.items [{name, isDirectory}], the top level names an extraction creates), archive, dir and names (append: add files to an existing archive; fails with code APPEND_UNSUPPORTED when the container cannot), archive and entries (archive-delete: delete entries and folders from an archive in place; fails with code DELETE_UNSUPPORTED when the container or the format cannot, ARCHIVE_WOULD_BE_EMPTY when nothing would remain), opId (compress, append, archive-delete and extract progress)"
   *             properties:
   *               path: { type: string }
   *               from: { type: string }
   *               to: { type: string }
   *               paths: { type: array, items: { type: string } }
   *               overwrite: { type: boolean }
   *               opId: { type: string }
   *     responses:
   *       200:
   *         description: "success is true; sha256 operations also return sha256 and du returns bytes, the content size of paths (0 when unknown)"
   *       400:
   *         description: "Missing or invalid field, or session not found"
   *       404:
   *         description: "Unknown operation"
   *       500:
   *         description: "Operation failed"
   */
  router.post(`${base}/fs/:op`, async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const signal = abortOnClose(req, res);
    const { containerId, op } = req.params;
    const b = bodyOf(req);
    try {
      const result = await sessions.run(session, async () => {
        const t = await targetOf(session, containerId, signal);
        // A client-chosen `opId` makes compress / extract report progress.
        const tracked =
          op === "compress" ||
          op === "append" ||
          op === "archive-delete" ||
          op === "extract" ||
          op === "extract-entries"
            ? opProgress.start(
                b.opId,
                session.userId,
                op === "archive-delete"
                  ? "delete"
                  : op === "compress" || op === "append"
                    ? op
                    : "extract",
              )
            : undefined;
        const o = { signal, progress: tracked };
        try {
          switch (op) {
            case "mkdir": {
              const path = safePath(b.path);
              await makeDirectory(t, path, o);
              return { detail: path };
            }
            case "create": {
              const path = safePath(b.path);
              await createFile(t, path, o);
              return { detail: path };
            }
            case "rename":
            case "move": {
              const from = safePath(b.from);
              const to = safePath(b.to);
              await movePath(t, from, to, flag(b.overwrite), o);
              return { detail: `${from} -> ${to}` };
            }
            case "copy": {
              const from = safePath(b.from);
              const to = safePath(b.to);
              await copyPath(t, from, to, flag(b.overwrite), o);
              return { detail: `${from} -> ${to}` };
            }
            case "delete": {
              if (!Array.isArray(b.paths) || b.paths.length === 0) {
                throw new HttpError(400, "paths is required");
              }
              const paths = b.paths.map(safePath);
              await deletePaths(t, paths, o);
              return { detail: paths.join(", ") };
            }
            case "chmod": {
              const path = safePath(b.path);
              await changeMode(
                t,
                path,
                String(b.mode ?? ""),
                flag(b.recursive),
                parseScope(b.scope),
                o,
              );
              return { detail: path };
            }
            case "chown": {
              const path = safePath(b.path);
              await changeOwner(
                t,
                path,
                String(b.owner ?? ""),
                flag(b.recursive),
                parseScope(b.scope),
                o,
              );
              return { detail: path };
            }
            case "symlink": {
              if (
                typeof b.target !== "string" ||
                !b.target ||
                b.target.includes("\0")
              ) {
                throw new HttpError(400, "target is required");
              }
              if (typeof b.path === "string" && !b.path.startsWith("/")) {
                throw new HttpError(400, "path must be absolute");
              }
              const path = safePath(b.path);
              await makeSymlink(t, b.target, path, flag(b.force), o);
              return { detail: path };
            }
            case "compress": {
              const dir = safePath(b.dir);
              if (!Array.isArray(b.names))
                throw new HttpError(400, "names is required");
              const names = b.names.map(safeName);
              const out = safePath(b.out);
              const format = String(b.format ?? "tgz") as ArchiveFormat;
              if (!["tar", "tgz", "zip"].includes(format)) {
                throw new HttpError(400, "Invalid format");
              }
              await compress(t, dir, names, out, format, o);
              return { detail: out };
            }
            case "append": {
              const archive = safePath(b.archive);
              const dir = safePath(b.dir);
              if (!Array.isArray(b.names))
                throw new HttpError(400, "names is required");
              await appendToArchive(t, archive, dir, b.names.map(safeName), o);
              return { detail: archive };
            }
            case "archive-delete": {
              const archive = safePath(b.archive);
              if (!Array.isArray(b.entries)) {
                throw new HttpError(400, "entries is required");
              }
              await deleteFromArchive(t, archive, b.entries.map(innerPath), o);
              return { detail: archive };
            }
            case "extract": {
              const archive = safePath(b.archive);
              const dest = safePath(b.dest);
              const policy = parseExtractPolicy(b);
              if (policy) {
                await extractWithPolicy(
                  t,
                  dest,
                  policy,
                  (stage) => extract(t, archive, stage, true, o),
                  signal,
                );
              } else {
                await extract(t, archive, dest, flag(b.overwrite), o);
              }
              return { detail: dest };
            }
            case "extract-plan": {
              const archive = safePath(b.archive);
              const chosen = Array.isArray(b.entries)
                ? b.entries.map(innerPath)
                : null;
              return {
                detail: archive,
                data: await extractPlanItems(t, archive, chosen, signal),
              };
            }
            case "extract-entries": {
              const archive = safePath(b.archive);
              const dest = safePath(b.dest);
              if (!Array.isArray(b.entries)) {
                throw new HttpError(400, "entries is required");
              }
              const entries = b.entries.map(innerPath);
              const policy = parseExtractPolicy(b);
              if (policy) {
                // Skipped entries are not extracted at all.
                const skipped = new Set(policy.skip);
                const wanted = entries.filter(
                  (e) => !skipped.has(e.slice(e.lastIndexOf("/") + 1)),
                );
                if (wanted.length === 0) {
                  throw new HttpError(400, "Nothing to extract");
                }
                await extractWithPolicy(
                  t,
                  dest,
                  { ...policy, skip: [] },
                  (stage) =>
                    extractArchiveEntries(
                      t,
                      archive,
                      stage,
                      wanted,
                      true,
                      signal,
                      tracked,
                    ),
                  signal,
                );
              } else {
                await extractArchiveEntries(
                  t,
                  archive,
                  dest,
                  entries,
                  flag(b.overwrite),
                  signal,
                  tracked,
                );
              }
              return { detail: `${archive} -> ${dest}` };
            }
            case "sha256": {
              const path = safePath(b.path);
              return {
                detail: path,
                data: { sha256: await sha256(t, path, o) },
              };
            }
            case "du": {
              if (
                !Array.isArray(b.paths) ||
                b.paths.length === 0 ||
                b.paths.length > 10_000
              ) {
                throw new HttpError(400, "paths is required");
              }
              const paths = b.paths.map(safePath);
              return {
                detail: paths.join(", "),
                data: { bytes: await duBytes(t, paths, signal) },
              };
            }
            default:
              throw new HttpError(404, "Unknown operation");
          }
        } catch (error) {
          tracked?.finish(error);
          throw error;
        } finally {
          tracked?.finish();
        }
      });
      if (op !== "sha256" && op !== "du" && op !== "extract-plan") {
        dropListings(session);
        audit(session, op, containerId, result.detail);
      }
      res.json({ success: true, ...("data" in result ? result.data : {}) });
    } catch (error) {
      fail(res, error, `Failed to ${op}`);
    }
  });

  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}/{containerId}/fs/stat:
   *   get:
   *     summary: "Stat a path inside a container"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *       - { name: containerId, in: path, required: true, schema: { type: string } }
   *       - { name: path, in: query, required: true, schema: { type: string } }
   *     responses:
   *       200:
   *         description: "File entry metadata"
   *       400:
   *         description: "Invalid path, or session not found"
   *       500:
   *         description: "Stat failed"
   */
  router.get(`${base}/fs/stat`, async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const signal = abortOnClose(req, res);
    try {
      const entry = await sessions.run(session, async () => {
        const t = await targetOf(session, req.params.containerId, signal);
        return statPath(t, safePath(req.query.path), { signal });
      });
      res.json(entry);
    } catch (error) {
      fail(res, error, "Failed to stat");
    }
  });

  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}/{containerId}/fs/read:
   *   get:
   *     summary: "Read a text file inside a container"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *       - { name: containerId, in: path, required: true, schema: { type: string } }
   *       - { name: path, in: query, required: true, schema: { type: string } }
   *     responses:
   *       200:
   *         description: "File content and metadata"
   *       400:
   *         description: "Invalid path, directory, or session not found"
   *       413:
   *         description: "File too large to edit"
   *       415:
   *         description: "Binary file"
   *       500:
   *         description: "Read failed"
   */
  router.get(`${base}/fs/read`, async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const signal = abortOnClose(req, res);
    try {
      const file = await sessions.run(session, async () => {
        const t = await targetOf(session, req.params.containerId, signal);
        return readTextFile(t, safePath(req.query.path), signal);
      });
      res.json(file);
    } catch (error) {
      fail(res, error, "Failed to read file");
    }
  });

  // ---- archives (read-only) ---------------------------------------------

  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}/{containerId}/fs/archive/list:
   *   get:
   *     summary: "List the entries of an archive inside a container"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *       - { name: containerId, in: path, required: true, schema: { type: string } }
   *       - { name: archive, in: query, required: true, schema: { type: string } }
   *       - { name: path, in: query, required: false, schema: { type: string } }
   *     responses:
   *       200:
   *         description: "Archive listing for the given inner directory"
   *       400:
   *         description: "Invalid path, or session not found"
   *       500:
   *         description: "Failed to open the archive"
   */
  router.get(`${base}/fs/archive/list`, async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const signal = abortOnClose(req, res);
    try {
      const archive = safePath(req.query.archive);
      const dir = innerPath(req.query.path);
      const listing = await sessions.run(session, async () => {
        const t = await targetOf(session, req.params.containerId, signal);
        return listArchive(t, archive, dir, signal);
      });
      res.json(listing);
    } catch (error) {
      fail(res, error, "Failed to open the archive");
    }
  });

  // One file from an archive: JSON text for the viewer, or the raw bytes
  // (?download=1) for saving and for media/binary previews.
  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}/{containerId}/fs/archive/entry:
   *   get:
   *     summary: "Read one file from an archive inside a container"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *       - { name: containerId, in: path, required: true, schema: { type: string } }
   *       - { name: archive, in: query, required: true, schema: { type: string } }
   *       - { name: path, in: query, required: true, schema: { type: string } }
   *       - { name: download, in: query, required: false, schema: { type: string, enum: ["1"] } }
   *     responses:
   *       200:
   *         description: "JSON with content, size, mtime and mode, or the raw bytes when download is 1"
   *       400:
   *         description: "Invalid path, or session not found"
   *       415:
   *         description: "Binary file (JSON mode only)"
   *       500:
   *         description: "Failed to read the archive entry"
   */
  router.get(`${base}/fs/archive/entry`, async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const signal = abortOnClose(req, res);
    try {
      const archive = safePath(req.query.archive);
      const path = innerPath(req.query.path);
      const raw = req.query.download === "1";
      const { data, entry } = await sessions.run(session, async () => {
        const t = await targetOf(session, req.params.containerId, signal);
        return readArchiveEntry(
          t,
          archive,
          path,
          raw ? undefined : EDITOR_MAX_BYTES,
          signal,
        );
      });
      if (raw) {
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", String(data.length));
        res.setHeader(
          "Content-Disposition",
          contentDisposition(entry.path.split("/").pop() ?? "file"),
        );
        res.end(data);
        return;
      }
      if (data.subarray(0, 8192).includes(0)) {
        throw new HttpError(415, "Binary file", "BINARY");
      }
      res.json({
        content: data.toString("utf8"),
        size: data.length,
        mtime: entry.mtime,
        mode: entry.mode,
      });
    } catch (error) {
      fail(res, error, "Failed to read the archive entry");
    }
  });

  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}/{containerId}/fs/write:
   *   put:
   *     summary: "Write a text file inside a container"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *       - { name: containerId, in: path, required: true, schema: { type: string } }
   *       - { name: path, in: query, required: true, schema: { type: string } }
   *       - { name: expectedMtime, in: query, required: false, schema: { type: number } }
   *     requestBody:
   *       required: true
   *       content:
   *         application/octet-stream:
   *           schema: { type: string, format: binary }
   *     responses:
   *       200:
   *         description: "success, plus the write result"
   *       400:
   *         description: "Invalid path or expectedMtime, or session not found"
   *       409:
   *         description: "File was modified since expectedMtime"
   *       413:
   *         description: "File too large to edit"
   *       500:
   *         description: "Write failed"
   */
  router.put(`${base}/fs/write`, async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const signal = abortOnClose(req, res);
    try {
      const path = safePath(req.query.path);
      const expected =
        typeof req.query.expectedMtime === "string" && req.query.expectedMtime
          ? Number(req.query.expectedMtime)
          : undefined;
      if (expected !== undefined && !Number.isFinite(expected)) {
        throw new HttpError(400, "Invalid expectedMtime");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > EDITOR_MAX_BYTES) {
          throw new HttpError(413, "File too large to edit", "TOO_LARGE");
        }
        chunks.push(chunk);
      }
      const result = await sessions.run(session, async () => {
        const t = await targetOf(session, req.params.containerId, signal);
        return writeTextFile(t, path, Buffer.concat(chunks), expected, signal);
      });
      dropListings(session);
      audit(session, "write", req.params.containerId, path);
      res.json({ success: true, ...result });
    } catch (error) {
      fail(res, error, "Failed to write file");
    }
  });

  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}/{containerId}/transfer/download:
   *   get:
   *     summary: "Download a file or directory from a container"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *       - { name: containerId, in: path, required: true, schema: { type: string } }
   *       - { name: path, in: query, required: true, schema: { type: string } }
   *       - { name: kind, in: query, required: false, schema: { type: string, enum: [file, directory] } }
   *       - { name: transferId, in: query, required: false, schema: { type: string } }
   *     responses:
   *       200:
   *         description: "Streamed file, or an archive for a directory"
   *       400:
   *         description: "Invalid transfer id, invalid path, or session not found"
   *       500:
   *         description: "Download failed"
   */
  router.get(`${base}/transfer/download`, async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const userId = session.userId;
    let transfer;
    try {
      transfer = transfers.start(req.query.transferId, userId, "download", 0);
    } catch (error) {
      return fail(res, error, "Download failed");
    }
    // A client that leaves while the channel is still opening must not leave it behind.
    res.on("close", () => {
      if (!res.writableFinished) transfer.controller.abort();
    });
    try {
      const path = safePath(req.query.path);
      const kind = req.query.kind === "directory" ? "directory" : "file";
      await sessions.run(session, async () => {
        const t = await targetOf(
          session,
          req.params.containerId,
          transfer.controller.signal,
        );
        await download(t, transfer, res, { path, kind });
      });
      transfers.finish(transfer);
      audit(session, "download", req.params.containerId, path);
    } catch (error) {
      transfers.finish(transfer, error);
      fail(res, error, "Download failed");
    }
  });

  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}/{containerId}/transfer/upload:
   *   put:
   *     summary: "Upload a file or tar stream into a container"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *       - { name: containerId, in: path, required: true, schema: { type: string } }
   *       - { name: dir, in: query, required: true, schema: { type: string } }
   *       - { name: format, in: query, required: false, schema: { type: string, enum: [file, tar] } }
   *       - { name: name, in: query, required: false, schema: { type: string } }
   *       - { name: rel, in: query, required: false, schema: { type: string } }
   *       - { name: overwrite, in: query, required: false, schema: { type: string } }
   *       - { name: mode, in: query, required: false, schema: { type: string, pattern: "^[0-7]{3,4}$" } }
   *       - { name: mtime, in: query, required: false, schema: { type: number } }
   *       - { name: size, in: query, required: false, schema: { type: integer }, description: "Byte count used when the request has no Content-Length" }
   *       - { name: transferId, in: query, required: false, schema: { type: string } }
   *     requestBody:
   *       required: true
   *       content:
   *         application/octet-stream:
   *           schema: { type: string, format: binary }
   *     responses:
   *       200:
   *         description: "success and the number of bytes written"
   *       400:
   *         description: "Invalid transfer id or path, or session not found"
   *       409:
   *         description: "Transfer id already in use"
   *       500:
   *         description: "Upload failed"
   */
  router.put(`${base}/transfer/upload`, async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const userId = session.userId;
    let transfer;
    try {
      const length = Number(
        req.headers["content-length"] ?? sizeParam(req.query.size),
      );
      transfer = transfers.start(
        req.query.transferId,
        userId,
        "upload",
        Number.isFinite(length) ? length : 0,
      );
    } catch (error) {
      return fail(res, error, "Upload failed");
    }
    try {
      const dir = safePath(req.query.dir);
      const format = req.query.format === "tar" ? "tar" : "file";
      const mode =
        typeof req.query.mode === "string" &&
        /^[0-7]{3,4}$/.test(req.query.mode)
          ? parseInt(req.query.mode, 8)
          : undefined;
      const mtimeSec = Number(req.query.mtime);
      const result = await sessions.run(session, async () => {
        const t = await targetOf(
          session,
          req.params.containerId,
          transfer.controller.signal,
        );
        return upload(t, transfer, req, res, {
          dir,
          format,
          name: typeof req.query.name === "string" ? req.query.name : undefined,
          rel: typeof req.query.rel === "string" ? req.query.rel : undefined,
          overwrite: flag(req.query.overwrite),
          mode,
          size: sizeParam(req.query.size),
          mtime:
            Number.isFinite(mtimeSec) && mtimeSec > 0
              ? new Date(mtimeSec * 1000)
              : undefined,
        });
      });
      transfers.finish(transfer);
      dropListings(session);
      audit(session, "upload", req.params.containerId, dir);
      res.json({ success: true, bytes: result.bytes });
    } catch (error) {
      transfers.finish(transfer, error);
      // Drain what the client still sends so it can read the error reply.
      req.resume();
      fail(res, error, "Upload failed");
    }
  });

  /**
   * @openapi
   * /plugin-api/container-files/operations/{opId}:
   *   get:
   *     summary: "Read the progress of a compress or extract operation"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: opId, in: path, required: true, schema: { type: string } }
   *     responses:
   *       200:
   *         description: "Operation progress"
   *       404:
   *         description: "Operation not found"
   */
  router.get("/operations/:opId", (req, res) => {
    const userId = userOf(res);
    if (!userId) return;
    const op = opProgress.get(req.params.opId, userId);
    if (!op) return res.status(404).json({ error: "Operation not found" });
    return res.json(op.view());
  });

  /**
   * @openapi
   * /plugin-api/container-files/transfers/{transferId}:
   *   get:
   *     summary: "Read the state of a transfer"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: transferId, in: path, required: true, schema: { type: string } }
   *     responses:
   *       200:
   *         description: "id, direction, state, bytes, total and error"
   *       404:
   *         description: "Transfer not found"
   */
  router.get("/transfers/:transferId", (req, res) => {
    const userId = userOf(res);
    if (!userId) return;
    const t = transfers.get(req.params.transferId, userId);
    if (!t) return res.status(404).json({ error: "Transfer not found" });
    return res.json({
      id: t.id,
      direction: t.direction,
      state: t.state,
      bytes: t.bytes,
      total: t.total,
      error: t.error,
    });
  });

  /**
   * @openapi
   * /plugin-api/container-files/transfers/{transferId}/cancel:
   *   post:
   *     summary: "Cancel a running transfer"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: transferId, in: path, required: true, schema: { type: string } }
   *     responses:
   *       200:
   *         description: "success is true when the transfer was cancelled"
   */
  router.post("/transfers/:transferId/cancel", (req, res) => {
    const userId = userOf(res);
    if (!userId) return;
    const cancelled = transfers.cancel(req.params.transferId, userId);
    return res.json({ success: cancelled });
  });

  registerTransferExtra(router, {
    ctx,
    sessions,
    log,
    transfers,
    userOf,
    sessionOf,
    targetOf,
    fail,
    audit,
    dropListings,
  });
}

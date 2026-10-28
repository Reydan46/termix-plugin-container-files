import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { relayCopy } from "./c2c.js";
import { CONTAINER_ID_RE, HttpError, type Logger } from "./helpers.js";
import type { ListTarget } from "./fs-list.js";
import { localOf, registerDesktop } from "./local-desktop.js";
import { LocalEvents } from "./local-events.js";
import { downloadToLocal, uploadFromLocal } from "./local-transfer.js";
import type { ContainerSession, Sessions } from "./sessions.js";
import { safeName, safePath } from "./shell-quote.js";
import type { Transfer, TransferRegistry } from "./transfers.js";

export interface ExtraDeps {
  ctx: PluginContext;
  sessions: Sessions;
  log: Logger;
  transfers: TransferRegistry;
  userOf: (res: Response) => string | null;
  sessionOf: (req: Request, res: Response) => ContainerSession | null;
  targetOf: (
    session: ContainerSession,
    containerId: string,
    signal: AbortSignal,
  ) => Promise<ListTarget>;
  fail: (res: Response, error: unknown, what: string) => void;
  audit: (
    session: ContainerSession,
    action: string,
    containerId: string,
    detail: string,
  ) => void;
  dropListings: (session: ContainerSession) => void;
}

type Body = Record<string, unknown>;

function containerId(value: unknown): string {
  if (typeof value !== "string" || !CONTAINER_ID_RE.test(value)) {
    throw new HttpError(400, "Invalid container id", "BAD_REQUEST");
  }
  return value;
}

function pathList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    throw new HttpError(400, "Invalid paths", "BAD_REQUEST");
  }
  return value.map((p) => safePath(p));
}

function localList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    throw new HttpError(400, "Invalid local paths", "BAD_REQUEST");
  }
  return value.map((p) => {
    if (typeof p !== "string" || !p || p.includes("\0")) {
      throw new HttpError(400, "Invalid local path", "BAD_REQUEST");
    }
    return p;
  });
}

/** `{ "name": "name (2)" }`: every target a plain file name. */
function renameMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (value === undefined || value === null) return out;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Invalid renames", "BAD_REQUEST");
  }
  for (const [from, to] of Object.entries(value)) {
    out[from] = safeName(to);
  }
  return out;
}

function nameList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new HttpError(400, "Invalid skip list", "BAD_REQUEST");
  }
  return value as string[];
}

/**
 * Extra transfer routes: container to container copy (Web and Desktop) and
 * the Desktop-only local bridge. Kept apart from routes.ts on purpose.
 */
export function registerTransferExtra(router: Router, deps: ExtraDeps): void {
  const { ctx, sessions, transfers, userOf, sessionOf, targetOf, fail } = deps;
  const events = new LocalEvents();
  ctx.disposables.add(() => events.clear());

  registerDesktop(router, { ctx, events, userOf });

  /**
   * Runs one tracked job inside the session. The request closing aborts it,
   * `POST /transfers/:id/cancel` aborts it too; either way both SSH channels
   * are destroyed by the job code.
   */
  const job = async (
    req: Request,
    res: Response,
    direction: Transfer["direction"],
    what: string,
    work: (
      session: ContainerSession,
      transfer: Transfer,
    ) => Promise<{ result: object; audit: [string, string, string] }>,
  ) => {
    const body = (req.body ?? {}) as Body;
    req.params.sessionId = String(body.sessionId ?? req.params.sessionId ?? "");
    const session = sessionOf(req, res);
    if (!session) return;
    let transfer: Transfer;
    try {
      transfer = transfers.start(body.transferId, session.userId, direction, 0);
    } catch (error) {
      return fail(res, error, what);
    }
    res.on("close", () => {
      if (!res.writableFinished) transfer.controller.abort();
    });
    const stopProgress = events.trackProgress(transfer);
    try {
      const out = await sessions.run(session, () => work(session, transfer));
      transfers.finish(transfer);
      stopProgress();
      deps.dropListings(session);
      deps.audit(session, ...out.audit);
      res.json({ success: true, bytes: transfer.bytes, ...out.result });
    } catch (error) {
      transfers.finish(transfer, error);
      stopProgress();
      deps.dropListings(session);
      fail(res, error, what);
    }
  };

  /**
   * @openapi
   * /plugin-api/container-files/containers/{sessionId}/copy:
   *   post:
   *     summary: "Copy files from one container to another"
   *     tags:
   *       - Container Files
   *     parameters:
   *       - { name: sessionId, in: path, required: true, schema: { type: string } }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [from, to]
   *             properties:
   *               transferId: { type: string }
   *               from: { type: object, description: "containerId and paths of the source" }
   *               to: { type: object, description: "containerId and dir of the destination" }
   *               renames: { type: object, description: "Map of source name to new file name" }
   *               skip: { type: array, items: { type: string } }
   *     responses:
   *       200:
   *         description: "success, bytes copied and the relay result"
   *       400:
   *         description: "Invalid body, or session not found"
   *       500:
   *         description: "Copy failed"
   */
  router.post("/containers/:sessionId/copy", (req, res) =>
    job(req, res, "c2c", "Copy failed", async (session, transfer) => {
      const body = (req.body ?? {}) as Body;
      const from = (body.from ?? {}) as Body;
      const to = (body.to ?? {}) as Body;
      const fromId = containerId(from.containerId);
      const toId = containerId(to.containerId);
      const paths = pathList(from.paths);
      const dir = safePath(to.dir);
      const renames = renameMap(body.renames);
      const skip = nameList(body.skip);
      const { signal } = transfer.controller;
      const src = await targetOf(session, fromId, signal);
      const dst = await targetOf(session, toId, signal);
      const result = await relayCopy(src, dst, transfer, {
        paths,
        dir,
        renames,
        skip,
      });
      return {
        result,
        audit: ["copy_between", toId, `${fromId}:${paths[0]} -> ${dir}`],
      };
    }),
  );

  /**
   * @openapi
   * /plugin-api/container-files/local/transfer/upload:
   *   post:
   *     summary: "Upload local desktop files into a container"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [sessionId, containerId, dir, localPaths]
   *             properties:
   *               sessionId: { type: string }
   *               containerId: { type: string }
   *               dir: { type: string }
   *               localPaths: { type: array, items: { type: string } }
   *               transferId: { type: string }
   *               renames: { type: object, description: "Map of source name to new file name" }
   *               skip: { type: array, items: { type: string } }
   *     responses:
   *       200:
   *         description: "success, bytes uploaded and the upload result"
   *       400:
   *         description: "Invalid body, or session not found"
   *       404:
   *         description: "Not the desktop app"
   *       500:
   *         description: "Upload failed"
   */
  router.post("/local/transfer/upload", (req, res) =>
    job(req, res, "local-up", "Upload failed", async (session, transfer) => {
      const body = (req.body ?? {}) as Body;
      const local = localOf(ctx);
      if (!local) throw new HttpError(404, "Not desktop", "NOT_DESKTOP");
      const id = containerId(body.containerId);
      const dir = safePath(body.dir);
      const localPaths = localList(body.localPaths);
      const t = await targetOf(session, id, transfer.controller.signal);
      const result = await uploadFromLocal(t, local.fs, transfer, {
        dir,
        localPaths,
        renames: renameMap(body.renames),
        skip: nameList(body.skip),
      });
      return { result, audit: ["local_upload", id, dir] };
    }),
  );

  /**
   * @openapi
   * /plugin-api/container-files/local/transfer/download:
   *   post:
   *     summary: "Download container files to the local desktop"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [sessionId, containerId, paths, localDir]
   *             properties:
   *               sessionId: { type: string }
   *               containerId: { type: string }
   *               paths: { type: array, items: { type: string } }
   *               localDir: { type: string }
   *               transferId: { type: string }
   *               renames: { type: object, description: "Map of source name to new file name" }
   *               skip: { type: array, items: { type: string } }
   *     responses:
   *       200:
   *         description: "success, bytes downloaded and the download result"
   *       400:
   *         description: "Invalid body, or session not found"
   *       404:
   *         description: "Not the desktop app"
   *       500:
   *         description: "Download failed"
   */
  router.post("/local/transfer/download", (req, res) =>
    job(
      req,
      res,
      "local-down",
      "Download failed",
      async (session, transfer) => {
        const body = (req.body ?? {}) as Body;
        const local = localOf(ctx);
        if (!local) throw new HttpError(404, "Not desktop", "NOT_DESKTOP");
        const id = containerId(body.containerId);
        const paths = pathList(body.paths);
        const localDir = localList([body.localDir])[0];
        const t = await targetOf(session, id, transfer.controller.signal);
        const result = await downloadToLocal(t, local.fs, transfer, {
          paths,
          localDir,
          renames: renameMap(body.renames),
          skip: nameList(body.skip),
        });
        return { result, audit: ["local_download", id, paths[0]] };
      },
    ),
  );
}

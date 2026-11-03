import type { Request, Response, Router } from "express";
import type {
  PluginContext,
  PluginDesktopLocal,
} from "@termix-ssh/plugin-sdk/backend";
import { getErrorMessage, HttpError } from "./helpers.js";
import { createKnownFoldersCache, loadKnownFolders } from "./known-folders.js";
import type { LocalEvents } from "./local-events.js";
import { stat } from "node:fs/promises";
import {
  checkLocalPaths,
  checkTempCopy,
  clearPathsClipboard,
  prepareTempDir,
  readFileClipboard,
  removeTempDir,
  setFileClipboard,
  setPathsClipboard,
} from "./os-clipboard.js";

interface Deps {
  ctx: PluginContext;
  events: LocalEvents;
  userOf: (res: Response) => string | null;
}

/** The desktop bridge when this backend is the desktop app's own. */
export function localOf(ctx: PluginContext): PluginDesktopLocal | null {
  try {
    return ctx.desktop.local.available() ? ctx.desktop.local : null;
  } catch {
    return null;
  }
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new HttpError(400, `Invalid ${what}`, "BAD_REQUEST");
  }
  return value;
}

function textList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    throw new HttpError(400, `Invalid ${what}`, "BAD_REQUEST");
  }
  return value.map((v) => text(v, what));
}

/** Replies in the `{success, ...}` shape the vendored local pane expects. */
export function localFail(res: Response, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const code =
    error instanceof HttpError
      ? error.code
      : (error as { code?: string } | null)?.code;
  res.json({
    success: false,
    error: getErrorMessage(error, "Local file operation failed"),
    ...(code ? { code } : {}),
  });
}

/**
 * `/local/*` routes (the contract of the vendored LocalFilePane) and the
 * `/local-events` socket. Everything answers 404 outside the desktop app.
 */
export function registerDesktop(
  router: Router,
  { ctx, events, userOf }: Deps,
): void {
  router.use("/local", (_req, res, next) => {
    if (!localOf(ctx)) {
      res.status(404).json({
        success: false,
        error: "Local files are only available in the desktop app",
        code: "NOT_DESKTOP",
      });
      return;
    }
    next();
  });

  const handle = (
    path: string,
    method: "get" | "post",
    run: (
      local: PluginDesktopLocal,
      body: Record<string, unknown>,
    ) => Promise<unknown>,
  ) => {
    router[method](`/local/${path}`, async (req: Request, res: Response) => {
      if (!userOf(res)) return;
      try {
        const local = localOf(ctx);
        if (!local) throw new HttpError(404, "Not desktop", "NOT_DESKTOP");
        const data = await run(
          local,
          (req.body ?? {}) as Record<string, unknown>,
        );
        res.json({ success: true, ...(data as object) });
      } catch (error) {
        localFail(res, error);
      }
    });
  };

  // Resolved once per backend run (a PowerShell round trip on Windows).
  const knownFolders = createKnownFoldersCache(async () => {
    const local = localOf(ctx);
    return local ? loadKnownFolders(local) : {};
  });

  /**
   * @openapi
   * /plugin-api/container-files/local/home:
   *   get:
   *     summary: "Local home folder, path separator and platform (desktop)"
   *     tags:
   *       - Container Files
   *     responses:
   *       200:
   *         description: "success, or success false with error and a code"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("home", "get", async (local) => {
    const info = await local.info();
    return {
      home: info.home,
      separator: info.separator,
      platform: info.platform,
    };
  });
  /**
   * @openapi
   * /plugin-api/container-files/local/known-folders:
   *   get:
   *     summary: "Local known folders such as Desktop and Downloads (desktop)"
   *     tags:
   *       - Container Files
   *     responses:
   *       200:
   *         description: "success, or success false with error and a code"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("known-folders", "get", async () => ({
    folders: await knownFolders(),
  }));
  /**
   * @openapi
   * /plugin-api/container-files/local/list:
   *   post:
   *     summary: "List a local folder (desktop)"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               path:
   *                 type: string
   *     responses:
   *       200:
   *         description: "success, or success false with error and a code"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("list", "post", (local, b) => local.fs.list(text(b.path, "path")));
  /**
   * @openapi
   * /plugin-api/container-files/local/mkdir:
   *   post:
   *     summary: "Create a local folder (desktop)"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               parent:
   *                 type: string
   *               name:
   *                 type: string
   *     responses:
   *       200:
   *         description: "success, or success false with error and a code"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("mkdir", "post", async (local, b) => ({
    path: await local.fs.mkdir(text(b.parent, "parent"), text(b.name, "name")),
  }));
  /**
   * @openapi
   * /plugin-api/container-files/local/create-file:
   *   post:
   *     summary: "Create an empty local file (desktop)"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               parent:
   *                 type: string
   *               name:
   *                 type: string
   *     responses:
   *       200:
   *         description: "success, or success false with error and a code"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("create-file", "post", async (local, b) => ({
    path: await local.fs.createFile(
      text(b.parent, "parent"),
      text(b.name, "name"),
    ),
  }));
  /**
   * @openapi
   * /plugin-api/container-files/local/rename:
   *   post:
   *     summary: "Rename a local file or folder (desktop)"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               path:
   *                 type: string
   *               name:
   *                 type: string
   *     responses:
   *       200:
   *         description: "success, or success false with error and a code"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("rename", "post", async (local, b) => ({
    path: await local.fs.rename(text(b.path, "path"), text(b.name, "name")),
  }));
  /**
   * @openapi
   * /plugin-api/container-files/local/trash:
   *   post:
   *     summary: "Move local files or folders to the trash (desktop)"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               paths:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: "success, or success false with error and a code"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("trash", "post", (local, b) =>
    local.fs.trash(textList(b.paths, "paths")),
  );
  /**
   * @openapi
   * /plugin-api/container-files/local/exists:
   *   post:
   *     summary: "Tell which of the given local paths exist (desktop)"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               paths:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: "success, or success false with error and a code"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("exists", "post", async (local, b) => ({
    existing: await local.fs.exists(textList(b.paths, "paths")),
  }));
  /**
   * @openapi
   * /plugin-api/container-files/local/ensure-dir:
   *   post:
   *     summary: "Create a local folder and its parents (desktop)"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               path:
   *                 type: string
   *               root:
   *                 type: string
   *     responses:
   *       200:
   *         description: "success, or success false with error and a code"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("ensure-dir", "post", async (local, b) => ({
    path: await local.fs.ensureDir(
      text(b.path, "path"),
      b.root === undefined || b.root === null
        ? undefined
        : text(b.root, "root"),
    ),
  }));
  /**
   * @openapi
   * /plugin-api/container-files/local/walk:
   *   post:
   *     summary: "List every file under the given local paths (desktop)"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               paths:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: "success, or success false with error and a code"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("walk", "post", (local, b) =>
    local.fs.walk(textList(b.paths, "paths")),
  );
  /**
   * @openapi
   * /plugin-api/container-files/local/reveal:
   *   post:
   *     summary: "Show a local path in the system file manager (desktop)"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               path:
   *                 type: string
   *     responses:
   *       200:
   *         description: "success, or success false with error and a code"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("reveal", "post", async (local, b) => {
    await local.fs.reveal(text(b.path, "path"));
    return {};
  });
  /**
   * @openapi
   * /plugin-api/container-files/local/open:
   *   post:
   *     summary: "Open a local path with the system default app (desktop)"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               path:
   *                 type: string
   *     responses:
   *       200:
   *         description: "success, or success false with error and a code"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("open", "post", async (local, b) => {
    await local.fs.open(text(b.path, "path"));
    return {};
  });

  // The OS file clipboard (Windows only; failures keep their reason, see
  // os-clipboard.ts). Copy in a container pane downloads the files into a temp
  // directory (prepare) and lists them on the clipboard (set); Paste reads what
  // Explorer copied (read) so it can be uploaded from the local paths.
  const windowsOnly = async (local: PluginDesktopLocal) => {
    if ((await local.info()).platform !== "win32")
      throw new HttpError(400, "Windows only", "UNSUPPORTED");
  };
  /**
   * @openapi
   * /plugin-api/container-files/local/clipboard/prepare:
   *   post:
   *     summary: "Make the temp directory for a container Copy (desktop, Windows)"
   *     tags:
   *       - Container Files
   *     responses:
   *       200:
   *         description: "success, or success false with error and a code"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("clipboard/prepare", "post", async (local) => {
    await windowsOnly(local);
    return { dir: await prepareTempDir() };
  });
  /**
   * @openapi
   * /plugin-api/container-files/local/clipboard/set:
   *   post:
   *     summary: "Put the files copied from a container on the Windows clipboard (desktop, Windows)"
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               dir:
   *                 type: string
   *               names:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: "success, or success false with error and a code"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("clipboard/set", "post", async (local, b) => {
    await windowsOnly(local);
    const names = Array.isArray(b.names) ? b.names.slice(0, 500) : [];
    await setFileClipboard(
      local,
      await checkTempCopy(text(b.dir, "dir"), names),
    );
    return {};
  });
  /**
   * @openapi
   * /plugin-api/container-files/local/clipboard/set-paths:
   *   post:
   *     summary: "Put real local files on the Windows clipboard (desktop, Windows)"
   *     description: "Copy in the local pane: lists the given absolute paths on the OS file clipboard with Set-Clipboard -LiteralPath (nothing is copied) and drops the temp copy of an earlier container Copy, so the newest Copy owns the clipboard."
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               paths:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: "success, or success false with error and a code (UNSUPPORTED, CLIP_SPAWN, CLIP_TIMEOUT, CLIP_EXIT, CLIP_SCRIPT)"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("clipboard/set-paths", "post", async (local, b) => {
    await windowsOnly(local);
    const paths = checkLocalPaths(b.paths);
    for (const p of paths) await stat(p);
    await removeTempDir();
    await setPathsClipboard(local, paths);
    return {};
  });
  /**
   * @openapi
   * /plugin-api/container-files/local/clipboard/read:
   *   post:
   *     summary: "Files and folders copied in Windows Explorer (desktop, Windows)"
   *     description: "Reads the file list on the OS clipboard with a local PowerShell (Get-Clipboard -Format FileDropList). own is true when the list is the plugin's own Copy."
   *     tags:
   *       - Container Files
   *     responses:
   *       200:
   *         description: "success, files [{path, isDirectory}] (empty when the clipboard holds no files) and own. A failure is success false with error and a code: UNSUPPORTED (not Windows), CLIP_SPAWN, CLIP_TIMEOUT, CLIP_EXIT or CLIP_SCRIPT (PowerShell, with the reason)"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("clipboard/read", "post", async (local) => {
    await windowsOnly(local);
    return await readFileClipboard(local);
  });
  /**
   * @openapi
   * /plugin-api/container-files/local/clipboard/clear-paths:
   *   post:
   *     summary: "Empty the Windows clipboard when it lists exactly these local files (desktop, Windows)"
   *     description: "After a local Cut was pasted the moved paths no longer exist. Empties the OS file clipboard only when it lists exactly the given absolute paths, so a newer Copy in Explorer stays."
   *     tags:
   *       - Container Files
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               paths:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: "success and cleared (true when the clipboard was emptied), or success false with error and a code (UNSUPPORTED, CLIP_SPAWN, CLIP_TIMEOUT, CLIP_EXIT, CLIP_SCRIPT)"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("clipboard/clear-paths", "post", async (local, b) => {
    await windowsOnly(local);
    return {
      cleared: await clearPathsClipboard(local, checkLocalPaths(b.paths)),
    };
  });
  /**
   * @openapi
   * /plugin-api/container-files/local/clipboard/clear:
   *   post:
   *     summary: "Remove the temp copy of an earlier container Copy (desktop)"
   *     tags:
   *       - Container Files
   *     responses:
   *       200:
   *         description: "success, or success false with error and a code"
   *       404:
   *         description: "Not the desktop app (code NOT_DESKTOP)"
   */
  handle("clipboard/clear", "post", async () => {
    await removeTempDir();
    return {};
  });

  ctx.ws.route("/local-events", (connection) => {
    const socket = connection.socket as {
      readyState: number;
      send: (data: string) => void;
      close: () => void;
      on: (event: string, fn: () => void) => void;
    };
    if (!localOf(ctx)) {
      socket.close();
      return;
    }
    const unsubscribe = events.subscribe(connection.userId, (event) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(event));
    });
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });
}

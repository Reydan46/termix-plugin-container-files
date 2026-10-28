import type { Request, Response, Router } from "express";
import type {
  PluginContext,
  PluginDesktopLocal,
} from "@termix-ssh/plugin-sdk/backend";
import { getErrorMessage, HttpError } from "./helpers.js";
import { createKnownFoldersCache, loadKnownFolders } from "./known-folders.js";
import type { LocalEvents } from "./local-events.js";

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

  handle("home", "get", async (local) => {
    const info = await local.info();
    return {
      home: info.home,
      separator: info.separator,
      platform: info.platform,
    };
  });
  handle("known-folders", "get", async () => ({
    folders: await knownFolders(),
  }));
  handle("list", "post", (local, b) => local.fs.list(text(b.path, "path")));
  handle("mkdir", "post", async (local, b) => ({
    path: await local.fs.mkdir(text(b.parent, "parent"), text(b.name, "name")),
  }));
  handle("create-file", "post", async (local, b) => ({
    path: await local.fs.createFile(
      text(b.parent, "parent"),
      text(b.name, "name"),
    ),
  }));
  handle("rename", "post", async (local, b) => ({
    path: await local.fs.rename(text(b.path, "path"), text(b.name, "name")),
  }));
  handle("trash", "post", (local, b) =>
    local.fs.trash(textList(b.paths, "paths")),
  );
  handle("exists", "post", async (local, b) => ({
    existing: await local.fs.exists(textList(b.paths, "paths")),
  }));
  handle("ensure-dir", "post", async (local, b) => ({
    path: await local.fs.ensureDir(
      text(b.path, "path"),
      b.root === undefined || b.root === null
        ? undefined
        : text(b.root, "root"),
    ),
  }));
  handle("walk", "post", (local, b) =>
    local.fs.walk(textList(b.paths, "paths")),
  );
  handle("reveal", "post", async (local, b) => {
    await local.fs.reveal(text(b.path, "path"));
    return {};
  });
  handle("open", "post", async (local, b) => {
    await local.fs.open(text(b.path, "path"));
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

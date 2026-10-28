import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createLogger } from "./helpers.js";
import { createSessions } from "./sessions.js";
import { registerConsole } from "./console.js";
import { registerRoutes } from "./routes.js";
import { TransferRegistry } from "./transfers.js";

export async function activate(ctx: PluginContext) {
  const log = createLogger(ctx.log);
  const sessions = createSessions(ctx.schedule, log);
  ctx.disposables.add(() => sessions.closeAll());

  const transfers = new TransferRegistry();
  ctx.disposables.add(() => transfers.abortAll());

  const router = ctx.http.router<Router>();
  registerRoutes(router, { ctx, sessions, log, transfers });

  registerConsole(ctx, { ctx, sessions, log });

  ctx.log.info("Container Files mounted at /plugin-api/container-files");
}

export async function deactivate() {}

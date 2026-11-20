import express, { type Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createLogger, strayErrors } from "./helpers.js";
import { hostOfClient, reaper } from "./exec.js";
import { createSessions } from "./sessions.js";
import { registerConsole } from "./console.js";
import { registerRoutes } from "./routes.js";
import { disposeTempDir, initTempDir } from "./os-clipboard.js";
import { TransferRegistry } from "./transfers.js";

/** Keeps one failed transfer from ending every session. */
function guardProcess(log: ReturnType<typeof createLogger>): () => void {
  const note = (kind: string) => (reason: unknown) => {
    const text =
      reason instanceof Error
        ? `${reason.name}: ${reason.message}\n${reason.stack ?? ""}`
        : String(reason);
    strayErrors.push({
      at: new Date().toISOString(),
      error: `${kind} ${text}`,
    });
    if (strayErrors.length > 20) strayErrors.shift();
    log.error(`Uncaught ${kind}`, reason);
  };
  const onException = note("exception");
  const onRejection = note("rejection");
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  return () => {
    process.off("uncaughtException", onException);
    process.off("unhandledRejection", onRejection);
  };
}

export async function activate(ctx: PluginContext) {
  const log = createLogger(ctx.log);
  ctx.disposables.add(guardProcess(log));
  reaper.run = async (client, script) => {
    const hostId = hostOfClient.get(client);
    if (hostId === undefined) throw new Error("Unknown host");
    const result = await ctx.ssh.exec(hostId, script, {
      purpose: "container-files",
      profile: "background",
      timeoutMs: 15_000,
    });
    return `${result.stdout.trim()} (exit ${result.code}) ${result.stderr.trim()}`.trim();
  };
  ctx.disposables.add(() => {
    reaper.run = undefined;
  });
  const sessions = createSessions(ctx.schedule, log);
  ctx.disposables.add(() => sessions.closeAll());

  const transfers = new TransferRegistry();
  ctx.disposables.add(() => transfers.abortAll());

  await initTempDir(await ctx.files.dataDir());
  ctx.disposables.add(() => disposeTempDir());

  // rawBody keeps core from parsing the body. Without it core answers every
  // request with an empty parsed body and never streams an upload to us.
  const router = ctx.http.router<Router>({ rawBody: true });
  router.use(express.json({ limit: "2mb" }));
  router.use(express.urlencoded({ limit: "2mb", extended: true }));
  // No body leaves req.body undefined in Express 5; give handlers {}.
  router.use((req, _res, next) => {
    req.body ??= {};
    next();
  });
  registerRoutes(router, { ctx, sessions, log, transfers });

  registerConsole(ctx, { ctx, sessions, log });

  ctx.log.info("Container Files mounted at /plugin-api/container-files");
}

export async function deactivate() {}

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, RequestHandler, Response } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { localOf } from "./local-desktop.js";

/** Routes of the linked server's copy of this plugin the desktop may reach. */
const ALLOWED_PREFIXES = [
  "/ssh/",
  "/containers/",
  "/transfers/",
  "/operations/",
];
const REQUEST_HEADERS = ["content-type", "content-length", "accept"];
const RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
];

function replyError(
  res: Response,
  status: number,
  error: string,
  code: string,
) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(status).json({ error, code });
}

/** Whether the server's own reply is one of our `{error, code}` bodies. */
function hasErrorCode(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { code?: unknown };
    return typeof parsed?.code === "string";
  } catch {
    return false;
  }
}

/**
 * `/remote/*`: forwards a request to the same plugin on the server the
 * desktop is linked to, streaming the body both ways. The desktop's own
 * backend keeps no session for such a request; the server does.
 */
export function createRemoteProxy(ctx: PluginContext): RequestHandler {
  return async (req: Request, res: Response) => {
    if (!ctx.currentActor()) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const local = localOf(ctx);
    if (!local) {
      replyError(
        res,
        404,
        "Remote access is only available in the desktop app",
        "NOT_DESKTOP",
      );
      return;
    }
    const sub = req.url;
    if (
      !ALLOWED_PREFIXES.some((prefix) => sub.startsWith(prefix)) ||
      /\.\.|%2e|%2f|%5c|\\|\/\//i.test(sub.split("?")[0])
    ) {
      replyError(res, 400, "Invalid remote path", "BAD_REQUEST");
      return;
    }

    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    req.on("aborted", () => controller.abort());

    const headers: Record<string, string> = {};
    for (const name of REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    let body: string | Readable | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.is("application/json") && req.body !== undefined) {
        // The host already parsed the body; send it again.
        body = JSON.stringify(req.body ?? {});
        delete headers["content-length"];
      } else {
        body = req;
      }
    }

    let response;
    try {
      response = await local.pluginFetch("remote", sub, {
        method: req.method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        res.destroy();
        return;
      }
      if ((error as { kind?: unknown })?.kind === "signed_out") {
        replyError(
          res,
          401,
          "The link to the server is signed out",
          "REMOTE_SIGNED_OUT",
        );
        return;
      }
      replyError(
        res,
        502,
        "The server cannot be reached",
        "REMOTE_UNAVAILABLE",
      );
      return;
    }

    try {
      if (response.status === 401) {
        const text = await response.text();
        if (hasErrorCode(text)) {
          res.status(401).type("application/json").send(text);
        } else {
          replyError(
            res,
            401,
            "The link to the server is signed out",
            "REMOTE_SIGNED_OUT",
          );
        }
        return;
      }
      res.status(response.status);
      for (const name of RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) res.setHeader(name, value);
      }
      // Send the head now so each chunk reaches the renderer as it arrives.
      res.flushHeaders();
      if (!response.body) {
        res.end();
        return;
      }
      await pipeline(Readable.from(response.body), res);
    } catch {
      // Headers are out or the client left; nothing more can be said.
      res.destroy();
    }
  };
}

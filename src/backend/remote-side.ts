import { Readable } from "node:stream";
import type { PluginDesktopLocal } from "@termix-ssh/plugin-sdk/backend";
import { HttpError } from "./helpers.js";

export type PluginFetch = PluginDesktopLocal["pluginFetch"];
type FetchResult = Awaited<ReturnType<PluginFetch>>;

/** What the server may use as a transfer id (see TransferRegistry). */
const MAX_ID_LENGTH = 64;

/**
 * The id a half of a local-pane transfer uses on the server: the local id plus
 * a suffix, cut so it still fits the server's id rule.
 */
export function remoteTransferId(transferId: string, suffix: string): string {
  const room = MAX_ID_LENGTH - suffix.length - 1;
  return `${transferId.slice(0, room)}-${suffix}`;
}

/** Turns a failed reply of the server's plugin back into an HttpError. */
async function replyError(response: FetchResult): Promise<HttpError> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    // The body is gone with the connection; the status still tells enough.
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown; code?: unknown };
    if (typeof parsed.error === "string") {
      return new HttpError(
        response.status,
        parsed.error,
        typeof parsed.code === "string" ? parsed.code : undefined,
      );
    }
  } catch {
    // Not one of our JSON bodies (a proxy page, for instance).
  }
  return new HttpError(
    response.status,
    `The server answered ${response.status}`,
    response.status === 401 ? "REMOTE_SIGNED_OUT" : "REMOTE_ERROR",
  );
}

/** The reply body as a Node stream of buffers. */
function bodyStream(response: FetchResult): Readable {
  const body = response.body;
  if (!body) return Readable.from([]);
  return Readable.from(
    (async function* () {
      for await (const chunk of body) {
        yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      }
    })(),
    { objectMode: false },
  );
}

/**
 * One container of a session on the linked server, reached through the
 * desktop link (`pluginFetch("remote")`). It speaks the same transfer routes a
 * browser uses, so the server needs nothing new for it.
 */
export class RemoteContainer {
  constructor(
    private readonly sessionId: string,
    private readonly containerId: string,
    private readonly pluginFetch: PluginFetch,
  ) {}

  private url(path: string, query?: Record<string, string>): string {
    const base = `/containers/${encodeURIComponent(this.sessionId)}/${encodeURIComponent(this.containerId)}${path}`;
    return query ? `${base}?${new URLSearchParams(query).toString()}` : base;
  }

  /** One call; a failed link or a cancel becomes the matching HttpError. */
  private async send(
    method: string,
    url: string,
    init: {
      body?: string | NodeJS.ReadableStream;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<FetchResult> {
    let response: FetchResult;
    try {
      response = await this.pluginFetch("remote", url, { method, ...init });
    } catch (error) {
      if (init.signal?.aborted) {
        throw new HttpError(499, "Cancelled", "CANCELLED");
      }
      if (error instanceof HttpError) throw error;
      if ((error as { kind?: unknown })?.kind === "signed_out") {
        throw new HttpError(
          401,
          "The link to the server is signed out",
          "REMOTE_SIGNED_OUT",
        );
      }
      throw new HttpError(
        502,
        "The server cannot be reached",
        "REMOTE_UNAVAILABLE",
      );
    }
    if (!response.ok) throw await replyError(response);
    return response;
  }

  private async put(
    query: Record<string, string>,
    body: NodeJS.ReadableStream,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.send(
      "PUT",
      this.url("/transfer/upload", query),
      {
        body,
        headers: { "content-type": "application/octet-stream" },
        signal,
      },
    );
    // The reply is small; reading it lets the connection finish cleanly.
    await response.text().catch(() => "");
  }

  /** Unpacks a tar stream into `dir` of the container (owner set there). */
  uploadTar(
    dir: string,
    stream: AsyncIterable<Buffer>,
    transferId: string,
    signal: AbortSignal,
  ): Promise<void> {
    return this.put(
      { dir, format: "tar", transferId },
      Readable.from(stream, { objectMode: false }),
      signal,
    );
  }

  /**
   * Writes one file of a known size to `dir/name`; the server writes it under
   * a temporary name and moves it into place.
   */
  uploadFile(
    dir: string,
    name: string,
    size: number,
    stream: NodeJS.ReadableStream,
    options: { transferId: string; signal: AbortSignal },
  ): Promise<void> {
    return this.put(
      {
        dir,
        format: "file",
        name,
        size: String(size),
        overwrite: "1",
        transferId: options.transferId,
      },
      stream,
      options.signal,
    );
  }

  /**
   * The `cp` tar of a file or a folder: the same stream format for both.
   * Destroying the returned stream closes the request.
   */
  async openTar(
    path: string,
    transferId: string,
    signal: AbortSignal,
    onBytes?: (n: number) => void,
  ): Promise<Readable> {
    const request = new AbortController();
    const onAbort = () => request.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const closed = () => {
      signal.removeEventListener("abort", onAbort);
      request.abort();
    };
    let response: FetchResult;
    try {
      response = await this.send(
        "GET",
        this.url("/transfer/download", {
          path,
          kind: "directory",
          transferId,
        }),
        { signal: request.signal },
      );
    } catch (error) {
      closed();
      if (signal.aborted) throw new HttpError(499, "Cancelled", "CANCELLED");
      throw error;
    }
    const stream = bodyStream(response);
    if (onBytes) stream.on("data", (chunk: Buffer) => onBytes(chunk.length));
    stream.once("close", closed);
    return stream;
  }

  /** Content size of `paths`, or 0 when the server cannot tell. */
  async duBytes(paths: string[], signal: AbortSignal): Promise<number> {
    try {
      const response = await this.send("POST", this.url("/fs/du"), {
        body: JSON.stringify({ paths }),
        headers: { "content-type": "application/json" },
        signal,
      });
      const data = JSON.parse(await response.text()) as { bytes?: unknown };
      return typeof data.bytes === "number" && data.bytes > 0 ? data.bytes : 0;
    } catch (error) {
      // An older server has no such route: progress is then indeterminate.
      if (signal.aborted) throw error;
      return 0;
    }
  }

  /** Best effort: asks the server to stop a half it may still be running. */
  async cancel(transferId: string): Promise<void> {
    try {
      await this.send(
        "POST",
        `/transfers/${encodeURIComponent(transferId)}/cancel`,
        {
          body: "{}",
          headers: { "content-type": "application/json" },
        },
      );
    } catch {
      // The request closing already stopped it, or the link is gone.
    }
  }
}

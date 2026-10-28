import type { Client, ClientChannel } from "ssh2";
import { HttpError } from "./helpers.js";

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}

export interface ExecOptions {
  stdin?: Buffer | string;
  /** Output beyond this aborts the command. */
  maxBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const MAX_STDERR = 64 * 1024;

/** Opens an exec channel; the caller owns the stream. */
export function openChannel(
  client: Client,
  command: string,
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error("Unable to open SSH channel"));
        return;
      }
      resolve(stream);
    });
  });
}

/**
 * Like openChannel, but a cancel that lands while the channel is still opening
 * destroys it once it opens (nothing leaks) and rejects as cancelled.
 */
export async function openChannelAbortable(
  client: Client,
  command: string,
  signal?: AbortSignal,
): Promise<ClientChannel> {
  signal?.throwIfAborted();
  const channel = await openChannel(client, command);
  if (signal?.aborted) {
    channel.destroy();
    throw new HttpError(499, "Cancelled", "CANCELLED");
  }
  return channel;
}

/** Resolves when the channel closes with exit code 0; rejects with stderr otherwise. */
export function channelDone(
  channel: ClientChannel,
  stderrCapture: { text: string } = { text: "" },
): Promise<void> {
  channel.stderr.on("data", (d: Buffer) => {
    if (stderrCapture.text.length < MAX_STDERR) {
      stderrCapture.text += d.toString();
    }
  });
  return new Promise((resolve, reject) => {
    let exitCode: number | null | undefined;
    channel.on("exit", (code: number | null) => {
      exitCode = code;
    });
    channel.once("error", reject);
    channel.once("close", (code: number | null) => {
      const final = exitCode ?? code;
      if (final === 0) resolve();
      else {
        reject(
          new HttpError(
            500,
            stderrCapture.text.trim() || `Command exited with code ${final}`,
            "EXEC_FAILED",
          ),
        );
      }
    });
  });
}

/** Runs a command and collects stdout (bounded). Does not throw on non-zero exit. */
export async function runCommand(
  client: Client,
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  options.signal?.throwIfAborted();
  const channel = await openChannel(client, command);
  return new Promise<ExecResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let exitCode: number | null | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const fail = (error: Error) => {
      channel.destroy();
      finish(() => reject(error));
    };
    const onAbort = () => fail(new HttpError(499, "Cancelled", "CANCELLED"));
    if (options.timeoutMs) {
      timer = setTimeout(
        () => fail(new HttpError(504, "Command timed out", "TIMEOUT")),
        options.timeoutMs,
      );
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    channel.on("data", (d: Buffer) => {
      size += d.length;
      if (options.maxBytes !== undefined && size > options.maxBytes) {
        fail(new HttpError(413, "Output too large", "TOO_LARGE"));
        return;
      }
      chunks.push(d);
    });
    channel.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += d.toString();
    });
    channel.on("exit", (code: number | null) => {
      exitCode = code;
    });
    channel.once("error", (e: Error) => fail(e));
    channel.once("close", (code: number | null) =>
      finish(() =>
        resolve({
          stdout: Buffer.concat(chunks),
          stderr,
          code: exitCode ?? code ?? null,
        }),
      ),
    );
    if (options.stdin !== undefined) channel.end(options.stdin);
  });
}

/** Like runCommand, but non-zero exit rejects with the command's stderr. */
export async function runChecked(
  client: Client,
  command: string,
  options: ExecOptions = {},
): Promise<Buffer> {
  const result = await runCommand(client, command, options);
  if (result.code !== 0) {
    throw new HttpError(
      500,
      result.stderr.trim() || `Command exited with code ${result.code}`,
      "EXEC_FAILED",
    );
  }
  return result.stdout;
}

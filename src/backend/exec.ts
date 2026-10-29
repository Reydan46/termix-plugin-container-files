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

/** Most exec channels one SSH session holds open at once (sshd MaxSessions is usually 10). */
export const MAX_SESSION_CHANNELS = 6;
/**
 * Extra channels only a nested open may use: a copy opens its destination while
 * it still holds the source, so without headroom enough sources would fill every
 * slot and all destinations would wait for each other. Stays under sshd's 10.
 */
const NESTED_EXTRA = 3;
const CHANNEL_WAIT_MS = 30_000;
const OPEN_RETRY_MS = 250;
const OPEN_FAILED =
  /open failed|administratively prohibited|resource shortage/i;

interface Waiter {
  nested: boolean;
  grant: () => void;
}

/** FIFO limiter for the exec channels of one SSH client. */
class ChannelSlots {
  private held = 0;
  private waiters: Waiter[] = [];

  get inUse(): number {
    return this.held;
  }

  get queued(): number {
    return this.waiters.length;
  }

  /** Resolves with a one-shot release; rejects when `signal` aborts or the wait times out. */
  acquire(signal?: AbortSignal, nested = false): Promise<() => void> {
    signal?.throwIfAborted();
    const release = () => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        this.held--;
        this.next();
      };
    };
    if (this.held < this.limit(nested)) {
      this.held++;
      return Promise.resolve(release());
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
      };
      const waiter: Waiter = {
        nested,
        grant: () => {
          cleanup();
          this.held++;
          resolve(release());
        },
      };
      const onAbort = () => {
        cleanup();
        reject(new HttpError(499, "Cancelled", "CANCELLED"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new HttpError(
            503,
            "Too many open SSH channels; try again shortly",
            "CHANNEL_BUSY",
          ),
        );
      }, CHANNEL_WAIT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private limit(nested: boolean): number {
    return MAX_SESSION_CHANNELS + (nested ? NESTED_EXTRA : 0);
  }

  private next(): void {
    for (;;) {
      const waiter = this.waiters.find((w) => this.held < this.limit(w.nested));
      if (!waiter) return;
      waiter.grant();
    }
  }
}

const slotsByClient = new WeakMap<Client, ChannelSlots>();

function slotsOf(client: Client): ChannelSlots {
  let slots = slotsByClient.get(client);
  if (!slots) {
    slots = new ChannelSlots();
    slotsByClient.set(client, slots);
  }
  return slots;
}

/** Channels currently held or waiting for a client (tests and diagnostics). */
export function channelLoad(client: Client): { inUse: number; queued: number } {
  const slots = slotsByClient.get(client);
  return { inUse: slots?.inUse ?? 0, queued: slots?.queued ?? 0 };
}

function execOnce(client: Client, command: string): Promise<ClientChannel> {
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

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new HttpError(499, "Cancelled", "CANCELLED"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Opens an exec channel; the caller owns the stream. At most
 * MAX_SESSION_CHANNELS are open per SSH client: later callers queue (FIFO,
 * abortable) and the slot frees when the channel closes. An "open failed"
 * refusal from sshd is retried once after a short pause.
 */
export async function openChannel(
  client: Client,
  command: string,
  signal?: AbortSignal,
  nested = false,
): Promise<ClientChannel> {
  const release = await slotsOf(client).acquire(signal, nested);
  try {
    let channel: ClientChannel;
    try {
      channel = await execOnce(client, command);
    } catch (error) {
      if (
        !(error instanceof Error && OPEN_FAILED.test(error.message)) ||
        signal?.aborted
      )
        throw error;
      await pause(OPEN_RETRY_MS, signal);
      channel = await execOnce(client, command);
    }
    channel.once("close", release);
    return channel;
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * Like openChannel, but a cancel that lands while the channel is still opening
 * destroys it once it opens (nothing leaks) and rejects as cancelled.
 */
export async function openChannelAbortable(
  client: Client,
  command: string,
  signal?: AbortSignal,
  nested = false,
): Promise<ClientChannel> {
  signal?.throwIfAborted();
  const channel = await openChannel(client, command, signal, nested);
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
  const channel = await openChannel(client, command, options.signal);
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

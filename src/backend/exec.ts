import { AsyncResource } from "node:async_hooks";
import { randomBytes } from "node:crypto";
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
/** Timing of the retry after sshd refuses a channel (tests shorten it). */
export const openTuning = { retryMs: 250, giveUpMs: 12_000 };
const KILL_AFTER_MS = 2_000;
const OPEN_FAILED =
  /open failed|administratively prohibited|resource shortage/i;

interface Waiter {
  nested: boolean;
  grant: () => void;
}

/** FIFO limiter for the exec channels of one SSH client. */
class ChannelSlots {
  private held = 0;
  /**
   * What the server turned out to allow. Others may share the connection (or
   * linger from a cancelled transfer), so a refusal lowers it to what we hold.
   */
  private cap = Infinity;
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
    return Math.min(
      this.cap,
      MAX_SESSION_CHANNELS + (nested ? NESTED_EXTRA : 0),
    );
  }

  /** sshd refused a channel while we held `held` ones: stay below that. */
  learn(refusedAt: number): void {
    this.cap = Math.max(1, Math.min(this.cap, refusedAt - 1));
  }

  /** A channel opened, so the server allows at least this many. */
  relax(): void {
    if (this.cap < MAX_SESSION_CHANNELS && this.held >= this.cap) this.cap++;
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

/** What it takes to stop the remote process of a channel for good. */
const remoteOf = new WeakMap<
  ClientChannel,
  {
    client: Client;
    tag: string;
    exited: boolean;
    reaping: boolean;
    scope: AsyncResource;
  }
>();

/**
 * Ends every remote process that carries the channel's tag. Closing an exec
 * channel does not stop a `docker cp` that waits on stdin or a pipe: it lives
 * on and blocks every later `docker exec` into that container.
 */
/**
 * Runs a script on the host over a connection of its own. sshd counts
 * MaxSessions per connection, so this still works when lingering processes
 * hold every session of the browsing connection. Set by the plugin entry.
 */
export const reaper: {
  run?: (client: Client, script: string) => Promise<string>;
} = {};

/** The latest reap attempts and how they ended (diagnostics). */
export const reapLog: {
  at: string;
  tag: string;
  via: string;
  result: string;
}[] = [];

/** The host a browsing connection belongs to, for the reaper. */
export const hostOfClient = new WeakMap<Client, number>();

function scheduleReap(info: {
  client: Client;
  tag: string;
  exited: boolean;
  reaping: boolean;
  scope: AsyncResource;
}): void {
  if (info.exited || info.reaping) return;
  info.reaping = true;
  const timer = setTimeout(() => {
    if (!info.exited) reapRemote(info);
  }, 1500);
  timer.unref?.();
}

function reapRemote(info: {
  client: Client;
  tag: string;
  scope: AsyncResource;
}): void {
  // Plain string: the \0 and \n are for the remote tr, not for this file.
  const script =
    'n=0; { for p in /proc/[0-9]*; do tr "\\0" "\\n" < "$p/environ" 2>/dev/null | grep -qx "CF_CH=' +
    info.tag +
    '" && { kill -KILL "${p#/proc/}" 2>/dev/null; n=$((n+1)); }; done; } 2>/dev/null; echo killed=$n';
  const entry = {
    at: new Date().toISOString(),
    tag: info.tag,
    via: "connection",
    result: "",
  };
  reapLog.push(entry);
  if (reapLog.length > 20) reapLog.shift();
  const viaChannel = () => {
    entry.via += "+channel";
    try {
      info.client.exec(script, (err, stream) => {
        if (err || !stream) {
          entry.result += ` | channel: ${err?.message ?? "no stream"}`;
          return;
        }
        let out = "";
        stream.on("error", () => {});
        stream.on("data", (d: Buffer) => (out += d.toString()));
        stream.on("close", () => {
          entry.result += ` | channel: ${out.trim()}`;
        });
        stream.stderr?.resume();
      });
    } catch (error) {
      entry.result += ` | channel threw: ${(error as Error).message}`;
    }
  };
  if (!reaper.run) {
    viaChannel();
    return;
  }
  info.scope
    .runInAsyncScope(() => reaper.run!(info.client, script))
    .then(
      (out) => {
        entry.result = out;
      },
      (error: Error) => {
        entry.result = `connection failed: ${error.message}`;
        viaChannel();
      },
    );
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
  const slots = slotsOf(client);
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const release = await slots.acquire(signal, nested);
    try {
      // Engine commands carry a tag so a cancel can find them on the host.
      const tag = command.startsWith('PATH="')
        ? randomBytes(8).toString("hex")
        : "";
      const channel = await execOnce(
        client,
        tag ? `CF_CH=${tag} ${command}` : command,
      );
      if (tag) {
        // The reap runs from a timer; ctx.ssh needs the request that opened it.
        const scope = new AsyncResource("container-files-reap");
        const info = { client, tag, exited: false, reaping: false, scope };
        remoteOf.set(channel, info);
        // A channel that closes without its process ever reporting an exit was
        // dropped on our side (a cancel, a broken pipe): the process may live on.
        channel.once("exit", () => {
          info.exited = true;
        });
        channel.once("close", () => scheduleReap(info));
      }
      slots.relax();
      channel.once("close", release);
      return channel;
    } catch (error) {
      const refused = error instanceof Error && OPEN_FAILED.test(error.message);
      const heldNow = slots.inUse;
      release();
      if (
        !refused ||
        signal?.aborted ||
        Date.now() - started > openTuning.giveUpMs
      ) {
        throw error;
      }
      // Lingering sessions (ours or another user of the connection) free up
      // within moments: stay under what the server allowed and try again.
      if (heldNow > 1) slots.learn(heldNow);
      await pause(Math.min(openTuning.retryMs * 2 ** attempt, 2000), signal);
    }
  }
}

/**
 * Ends a channel for good: asks the remote process to stop (OpenSSH honours
 * signal requests), closes our side, and insists a moment later. A session
 * whose process lingers keeps counting against sshd's MaxSessions.
 */
export function killChannel(channel: ClientChannel): void {
  const send = (name: string) => {
    try {
      (channel as { signal?: (n: string) => void }).signal?.(name);
    } catch {
      // The channel is already closing.
    }
  };
  // docker ignores SIGTERM while it waits on a pipe, so ask for KILL at once.
  send("KILL");
  const remote = remoteOf.get(channel);
  if (remote) scheduleReap(remote);
  try {
    channel.destroy();
  } catch {
    // Already closed.
  }
  const timer = setTimeout(() => {
    send("KILL");
    try {
      channel.destroy();
    } catch {
      // Already closed.
    }
  }, KILL_AFTER_MS);
  timer.unref?.();
  channel.once("close", () => clearTimeout(timer));
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
    killChannel(channel);
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
    // Later errors (a write after the channel was killed) must not go unheard.
    channel.on("error", () => {});
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
      killChannel(channel);
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

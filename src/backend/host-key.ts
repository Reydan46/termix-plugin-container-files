/**
 * Asking about a host key that is new or has changed.
 *
 * ctx.ssh.connect has no way to ask: a key the host never saw is refused with
 * "verification failed". Core's verifier can ask, but only over the ws socket
 * handed to ctx.ssh.prepare, so after such a refusal this runs a probe: it
 * prepares a throwaway ssh2 client with a socket of our own, lets core's
 * verifier talk to it, turns its questions into a step of the HTTP connect
 * protocol (the desktop reaches a server host through the /ssh/ proxy, which
 * forwards HTTP only) and carries the person's answer back.
 *
 * Verification is never weakened. Core decides, stores the key only on an
 * explicit accept, and the probe itself always refuses the handshake, so it
 * never logs in. A reject, a timeout or an abandoned connect leaves the
 * original refusal in place. Once the key is accepted, the real connect runs
 * again and finds it stored.
 */

import type {
  PluginContext,
  PluginSshHost,
  PluginSshPromptChannel,
} from "@termix-ssh/plugin-sdk/backend";

/** What the person is shown; the field names match core's own message. */
export interface HostKeyPrompt {
  scenario: "new" | "changed";
  ip: string;
  port: number;
  hostname?: string;
  fingerprint: string;
  oldFingerprint?: string;
  keyType: string;
  oldKeyType?: string;
  algorithm: string;
}

// Core gives up on its own after these (host-key-verifier.ts). The pending
// connect outlives them a little so core's timeout is what ends the wait.
export const NEW_KEY_WAIT_MS = 60 * 1000;
export const CHANGED_KEY_WAIT_MS = 120 * 1000;
const WAIT_MARGIN_MS = 15 * 1000;

export function hostKeyWaitMs(scenario: HostKeyPrompt["scenario"]): number {
  return (
    (scenario === "changed" ? CHANGED_KEY_WAIT_MS : NEW_KEY_WAIT_MS) +
    WAIT_MARGIN_MS
  );
}

export type HostKeyAnswer = "accept" | "reject" | null;

export interface HostKeyAsker {
  /**
   * Shows the question and resolves with the answer, or null when nobody
   * will answer (the connect was abandoned).
   */
  ask: (prompt: HostKeyPrompt) => Promise<HostKeyAnswer>;
  /** Core stopped waiting without an answer: drop the open question. */
  dismiss: () => void;
}

export type HostKeyResult =
  /** The person accepted and core stored the key: connect again. */
  | "accepted"
  | "rejected"
  /** Nobody answered before core gave up. */
  | "timeout"
  /** The connect was abandoned while the question was open. */
  | "abandoned"
  /** The probe could not run: keep the original refusal. */
  | "unavailable";

/** The part of an ssh2 Client the probe drives. */
export interface ProbeClient {
  connect: (config: Record<string, unknown>) => unknown;
  end: () => unknown;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export type ProbeClientFactory = () => Promise<ProbeClient>;

async function defaultFactory(): Promise<ProbeClient> {
  // ssh2 is the host's own copy (a peer dependency), loaded only when asked.
  const mod = (await import("ssh2")) as unknown as {
    Client?: new () => ProbeClient;
    default?: { Client?: new () => ProbeClient };
  };
  const Ctor = mod.Client ?? mod.default?.Client;
  if (!Ctor) throw new Error("ssh2 is not available");
  return new Ctor();
}

let makeClient: ProbeClientFactory = defaultFactory;

/** Tests swap the client; null restores the real one. */
export function setProbeClientFactory(factory: ProbeClientFactory | null) {
  makeClient = factory ?? defaultFactory;
}

/** Whether ssh2 refused because the verifier said no. */
export function isHostKeyRefusal(error: unknown): boolean {
  return (
    error instanceof Error && /verification failed/i.test(error.message ?? "")
  );
}

type Listener = (data: Buffer) => void;

/**
 * The slice of a ws socket core's verifier uses: send, on("message") and
 * removeListener. Its questions go to `onPrompt`; the answer comes back as
 * the message core is listening for.
 */
class HostKeySocket {
  readonly OPEN = 1;
  readyState = 1;
  prompted = false;
  answered = false;
  /** Core gave up before anyone answered. */
  timedOut = false;
  private handlers = new Set<Listener>();

  constructor(
    private readonly asker: HostKeyAsker,
    private readonly onAnswer: (answer: HostKeyAnswer) => void,
  ) {}

  send(raw: string): void {
    let message: { type?: string; data?: HostKeyPrompt };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (
      (message.type !== "host_key_verification_required" &&
        message.type !== "host_key_changed") ||
      !message.data
    ) {
      return;
    }
    this.prompted = true;
    const d = message.data;
    // Only the fields the dialog shows, in the shape they are sent on.
    const prompt: HostKeyPrompt = {
      scenario: message.type === "host_key_changed" ? "changed" : "new",
      ip: String(d.ip ?? ""),
      port: Number(d.port ?? 22),
      hostname: typeof d.hostname === "string" ? d.hostname : undefined,
      fingerprint: String(d.fingerprint ?? ""),
      oldFingerprint:
        typeof d.oldFingerprint === "string" ? d.oldFingerprint : undefined,
      keyType: String(d.keyType ?? "unknown"),
      oldKeyType: typeof d.oldKeyType === "string" ? d.oldKeyType : undefined,
      algorithm: String(d.algorithm ?? "sha256"),
    };
    void this.asker.ask(prompt).then((answer) => {
      if (this.timedOut) return;
      this.answered = true;
      this.onAnswer(answer);
      this.deliver(answer === "accept" ? "accept" : "reject");
    });
  }

  private deliver(action: "accept" | "reject") {
    const data = Buffer.from(
      JSON.stringify({
        type: "host_key_verification_response",
        data: { action },
      }),
    );
    for (const handler of [...this.handlers]) handler(data);
  }

  // The names core calls, plus the usual aliases. Only messages matter here.
  on(event: string, listener: Listener): this {
    if (event === "message") this.handlers.add(listener);
    return this;
  }

  once(event: string, listener: Listener): this {
    return this.on(event, listener);
  }

  off(event: string, listener: Listener): this {
    return this.removeListener(event, listener);
  }

  removeListener(event: string, listener: Listener): this {
    if (event === "message") {
      const had = this.handlers.delete(listener);
      // Core drops its listener on a response and on its own timeout; with no
      // answer given it is the timeout.
      if (had && this.prompted && !this.answered) {
        this.timedOut = true;
        this.asker.dismiss();
      }
    }
    return this;
  }
}

export interface NegotiateInput {
  host: PluginSshHost;
  asker: HostKeyAsker;
  /** For a jump host in the way asking for a code. */
  prompt?: PluginSshPromptChannel;
  log?: (level: "info" | "warning" | "error", message: string) => void;
  isAbandoned: () => boolean;
}

/**
 * Connects a probe to the host so core's verifier asks about its key, and
 * reports what the person decided. Never logs in.
 */
export async function negotiateHostKey(
  ctx: PluginContext,
  input: NegotiateInput,
): Promise<HostKeyResult> {
  const { host, asker, log } = input;

  let client: ProbeClient;
  try {
    client = await makeClient();
  } catch {
    return "unavailable";
  }
  client.on("error", () => {
    // Reported through the result; an unhandled error would crash the host.
  });

  let abandoned = false;
  const socket = new HostKeySocket(asker, (answer) => {
    if (answer === null) abandoned = true;
  });

  let prepared;
  try {
    prepared = await ctx.ssh.prepare(host, {
      purpose: "container-files",
      profile: "session",
      client,
      interactive: false,
      hostKeySocket: socket,
      log,
    });
  } catch {
    return "unavailable";
  }
  const config = prepared.config;
  const original = config.hostVerifier;
  if (prepared.outcome.status !== "ready" || typeof original !== "function") {
    return "unavailable";
  }

  let jumpClient: { end?: () => unknown } | null = null;
  try {
    const transport = await ctx.ssh.openTransport(host, config, {
      log,
      prompt: input.prompt,
    });
    jumpClient = (transport.jumpClient as typeof jumpClient) ?? null;
  } catch {
    return "unavailable";
  }
  if (input.isAbandoned()) {
    cleanup(client, jumpClient);
    return "abandoned";
  }

  return new Promise<HostKeyResult>((resolve) => {
    let decided: boolean | null = null;
    let verifierRan = false;
    let safety: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const settle = (result: HostKeyResult) => {
      if (settled) return;
      settled = true;
      if (safety) clearTimeout(safety);
      cleanup(client, jumpClient);
      resolve(result);
    };

    const outcomeOf = (accepted: boolean): HostKeyResult => {
      if (abandoned) return "abandoned";
      // Core that never asked (it ignored the socket) decided on its own and
      // stored nothing: nobody answered, so there is nothing to retry.
      if (!socket.prompted) return "unavailable";
      if (accepted) return "accepted";
      return socket.timedOut || !socket.answered ? "timeout" : "rejected";
    };

    config.hostVerifier = (
      key: Buffer,
      done: (valid: boolean) => void,
    ): void => {
      verifierRan = true;
      const decide = (valid: boolean) => {
        if (decided !== null) return;
        decided = valid;
        // Refuse the handshake either way: the probe never logs in. Core has
        // already stored the key when it accepted.
        try {
          done(false);
        } catch {
          // The client may already be closed.
        }
        settle(outcomeOf(valid));
      };
      // Core's verifier asks over the socket, which can take a while.
      safety = setTimeout(
        () => {
          if (decided === null) {
            decided = false;
            settle("timeout");
          }
        },
        Math.max(CHANGED_KEY_WAIT_MS, NEW_KEY_WAIT_MS) + WAIT_MARGIN_MS,
      );
      const returned = (
        original as (k: Buffer, cb: (valid: boolean) => void) => unknown
      )(key, decide);
      if (typeof returned === "boolean") decide(returned);
    };

    // A drop before the verifier ran means the host cannot be reached; after
    // it, the answer still decides, because core stores an accepted key even
    // if this connection is gone.
    const failed = () => {
      if (!verifierRan) settle("unavailable");
    };
    client.on("error", failed);
    client.on("close", failed);

    try {
      client.connect(config);
    } catch {
      settle("unavailable");
    }
  });
}

function cleanup(
  client: ProbeClient,
  jumpClient: { end?: () => unknown } | null,
) {
  for (const target of [client, jumpClient]) {
    try {
      target?.end?.();
    } catch {
      // Already closed.
    }
  }
}

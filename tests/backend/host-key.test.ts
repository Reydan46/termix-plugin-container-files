import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { setProbeClientFactory } from "../../src/backend/host-key";
import { startServer, type TestServer } from "./server";

/**
 * What core's SSHHostKeyVerifier does with the socket it is given: send the
 * question, wait for the response message, store the key only on accept, and
 * refuse after its own timeout.
 */
function coreVerifier(
  ws: {
    send: (s: string) => void;
    on: (e: string, l: (d: Buffer) => void) => unknown;
    removeListener: (e: string, l: (d: Buffer) => void) => unknown;
  },
  scenario: "new" | "changed",
  store: { stored: boolean },
  timeoutMs = 5000,
) {
  return (_key: Buffer, verify: (valid: boolean) => void) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      verify(false);
    }, timeoutMs);
    const handler = (data: Buffer) => {
      const message = JSON.parse(data.toString());
      if (message.type !== "host_key_verification_response") return;
      clearTimeout(timer);
      ws.removeListener("message", handler);
      const accepted = message.data.action === "accept";
      if (accepted) store.stored = true;
      verify(accepted);
    };
    ws.on("message", handler);
    ws.send(
      JSON.stringify(
        scenario === "new"
          ? {
              type: "host_key_verification_required",
              data: {
                scenario,
                ip: "10.0.0.7",
                port: 22,
                hostname: "host-7",
                fingerprint: "aabbcc",
                keyType: "ssh-ed25519",
                algorithm: "sha256",
              },
            }
          : {
              type: "host_key_changed",
              data: {
                scenario,
                ip: "10.0.0.7",
                port: 22,
                hostname: "host-7",
                fingerprint: "aabbcc",
                oldFingerprint: "112233",
                keyType: "ssh-ed25519",
                oldKeyType: "ssh-rsa",
                algorithm: "sha256",
              },
            },
      ),
    );
  };
}

/** An ssh2 Client that only runs the host verifier, then is refused. */
class ProbeClient extends EventEmitter {
  ended = false;
  verifierResult: boolean | null = null;
  connect(config: Record<string, unknown>) {
    setImmediate(() => {
      const verifier = config.hostVerifier as (
        key: Buffer,
        done: (valid: boolean) => void,
      ) => void;
      verifier(Buffer.from("key"), (valid) => {
        this.verifierResult = valid;
        if (!valid) this.emit("error", new Error("Host denied"));
      });
    });
  }
  end() {
    this.ended = true;
  }
}

interface Setup {
  scenario: "new" | "changed";
  store: { stored: boolean };
  probes: ProbeClient[];
  prepared: number;
}

/** Makes the plain connect refuse until the key is stored. */
function setup(
  s: TestServer,
  scenario: "new" | "changed",
  timeoutMs?: number,
): Setup {
  const state: Setup = {
    scenario,
    store: { stored: false },
    probes: [],
    prepared: 0,
  };
  setProbeClientFactory(async () => {
    const probe = new ProbeClient();
    state.probes.push(probe);
    return probe;
  });
  const ssh = s.mock.ctx.ssh;
  const realConnect = ssh.connect;
  ssh.connect = (async (...args: Parameters<typeof realConnect>) => {
    if (!state.store.stored) {
      throw new Error("Host denied (verification failed)");
    }
    return realConnect(...args);
  }) as typeof ssh.connect;
  ssh.prepare = (async (_host: unknown, options: { hostKeySocket?: never }) => {
    state.prepared += 1;
    return {
      config: {
        hostVerifier: coreVerifier(
          options.hostKeySocket as never,
          scenario,
          state.store,
          timeoutMs,
        ),
      },
      outcome: { status: "ready" },
      authType: null,
    };
  }) as unknown as typeof ssh.prepare;
  return state;
}

let server: TestServer | undefined;

afterEach(async () => {
  setProbeClientFactory(null);
  await server?.close();
  server = undefined;
});

const connect = (s: TestServer, hostKeyPrompt = true) =>
  s.request("POST", "/ssh/connect", {
    body: { sessionId: "s1", hostId: 7, hostKeyPrompt },
  });
const answer = (s: TestServer, action: string) =>
  s.request("POST", "/ssh/connect-host-key", {
    body: { sessionId: "s1", action },
  });

describe("host key prompt", () => {
  it("asks about a new key and connects once it is accepted", async () => {
    server = await startServer();
    const state = setup(server, "new");

    const first = await connect(server);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      requires_host_key: true,
      sessionId: "s1",
      scenario: "new",
      ip: "10.0.0.7",
      port: 22,
      hostname: "host-7",
      fingerprint: "aabbcc",
      keyType: "ssh-ed25519",
      algorithm: "sha256",
    });
    expect(first.body.oldFingerprint).toBeUndefined();
    expect(state.store.stored).toBe(false);

    const done = await answer(server, "accept");
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ success: true, runtime: "docker" });
    expect(state.store.stored).toBe(true);
    // The probe never logs in: it refuses the handshake itself.
    expect(state.probes[0].verifierResult).toBe(false);
    expect(state.probes[0].ended).toBe(true);

    const list = await server.request("GET", "/containers/s1");
    expect(list.status).toBe(200);
  });

  it("fails clearly when a new key is rejected", async () => {
    server = await startServer();
    const state = setup(server, "new");

    const first = await connect(server);
    expect(first.body.requires_host_key).toBe(true);
    const done = await answer(server, "reject");

    expect(done.status).toBe(400);
    expect(done.body.code).toBe("HOST_KEY_REJECTED");
    expect(state.store.stored).toBe(false);
    expect(
      done.body.connectionLogs.some(
        (l: { type: string }) => l.type === "error",
      ),
    ).toBe(false);
    // The pending connect is gone, so nothing can accept it afterwards.
    expect((await answer(server, "accept")).status).toBe(404);
  });

  it("shows the old fingerprint for a changed key and connects on accept", async () => {
    server = await startServer();
    const state = setup(server, "changed");

    const first = await connect(server);
    expect(first.body).toMatchObject({
      requires_host_key: true,
      scenario: "changed",
      fingerprint: "aabbcc",
      oldFingerprint: "112233",
      oldKeyType: "ssh-rsa",
    });
    const done = await answer(server, "accept");
    expect(done.status).toBe(200);
    expect(done.body.success).toBe(true);
    expect(state.store.stored).toBe(true);
  });

  it("fails when a changed key is rejected", async () => {
    server = await startServer();
    const state = setup(server, "changed");

    await connect(server);
    const done = await answer(server, "reject");

    expect(done.status).toBe(400);
    expect(done.body.code).toBe("HOST_KEY_REJECTED");
    expect(state.store.stored).toBe(false);
  });

  it("fails with a timeout when nobody answers before core gives up", async () => {
    server = await startServer();
    const state = setup(server, "new", 30);

    const first = await connect(server);
    expect(first.body.requires_host_key).toBe(true);
    await new Promise((r) => setTimeout(r, 120));

    // The step that ended the wait is the one the next request gets, and a
    // late accept cannot revive the connect.
    const late = await answer(server, "accept");
    expect(late.status).toBe(404);
    expect(state.store.stored).toBe(false);
    expect(state.probes[0].ended).toBe(true);
    const session = await server.request("GET", "/containers/s1");
    expect(session.status).not.toBe(200);
  });

  it("drops the question when the connect is abandoned", async () => {
    server = await startServer();
    const state = setup(server, "new");
    const connections = () => server!.mock.sshConnections.length;

    await connect(server);
    const before = connections();
    await server.request("POST", "/ssh/disconnect", {
      body: { sessionId: "s1" },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(state.store.stored).toBe(false);
    expect(connections()).toBe(before);
    expect(state.probes[0].ended).toBe(true);
    expect((await answer(server, "accept")).status).toBe(404);
  });

  it("keeps today's error for a client that cannot show the dialog", async () => {
    server = await startServer();
    const state = setup(server, "new");

    const res = await connect(server, false);

    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/verification failed/);
    expect(res.body.requires_host_key).toBeUndefined();
    expect(state.prepared).toBe(0);
  });

  it("keeps today's error when the core cannot prepare a verifier", async () => {
    server = await startServer();
    const state = setup(server, "new");
    // An older core: prepare hands back no verifier to drive.
    server.mock.ctx.ssh.prepare = (async () => ({
      config: {},
      outcome: { status: "ready" },
      authType: null,
    })) as unknown as typeof server.mock.ctx.ssh.prepare;

    const res = await connect(server);

    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/verification failed/);
    expect(state.store.stored).toBe(false);
  });

  it("keeps today's error when core decides without asking", async () => {
    server = await startServer();
    const state = setup(server, "new");
    // A core that ignores the socket accepts the key itself and stores nothing.
    server.mock.ctx.ssh.prepare = (async () => ({
      config: {
        hostVerifier: (_key: Buffer, done: (valid: boolean) => void) =>
          done(true),
      },
      outcome: { status: "ready" },
      authType: null,
    })) as unknown as typeof server.mock.ctx.ssh.prepare;

    const res = await connect(server);

    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/verification failed/);
    expect(state.store.stored).toBe(false);
  });

  it("only accepts the two actions", async () => {
    server = await startServer();
    setup(server, "new");
    await connect(server);

    expect((await answer(server, "maybe")).status).toBe(400);
    expect(
      (await server.request("POST", "/ssh/connect-host-key", { body: {} }))
        .status,
    ).toBe(400);
    // Still waiting: a real answer works.
    expect((await answer(server, "accept")).status).toBe(200);
  });

  it("does not let another user answer", async () => {
    server = await startServer();
    const state = setup(server, "new");
    await connect(server);

    const other = await server.request("POST", "/ssh/connect-host-key", {
      user: "user-2",
      body: { sessionId: "s1", action: "accept" },
    });
    expect(other.status).toBe(404);
    expect(state.store.stored).toBe(false);
  });
});

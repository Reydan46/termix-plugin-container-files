import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildConsoleCommand,
  isConsoleShell,
} from "../../src/backend/console-command";
import {
  CONSOLE_IDLE_MS,
  createConsoleHandler,
  type ConsoleSocket,
} from "../../src/backend/console";
import type { ContainerSession, Sessions } from "../../src/backend/sessions";
import { FakeClient, type FakeStream } from "./fake-ssh";

const base = {
  runtime: "docker" as const,
  containerId: "abc123def456",
  dir: "/var/www",
  shell: "bash",
};

describe("console command", () => {
  it("runs exec with a tty, the workdir and the shell, all quoted", () => {
    const cmd = buildConsoleCommand(base);
    expect(cmd).toMatch(
      /docker 'exec' '-it' '-w' '\/var\/www' 'abc123def456' 'bash'$/,
    );
  });

  it("falls back from bash to sh for auto and supports podman", () => {
    const cmd = buildConsoleCommand({
      ...base,
      runtime: "podman",
      shell: "auto",
    });
    expect(cmd).toContain(
      "podman 'exec' '-it' '-w' '/var/www' 'abc123def456' 'sh' '-c'",
    );
    expect(cmd).toContain("exec bash || exec sh");
  });

  it("quotes folders with spaces and quotes", () => {
    expect(buildConsoleCommand({ ...base, dir: "/a b/it's;ls" })).toContain(
      `'/a b/it'\\''s;ls'`,
    );
  });

  it("rejects bad folders, shells, ids and runtimes", () => {
    expect(() => buildConsoleCommand({ ...base, dir: "/a\nid" })).toThrow();
    expect(() => buildConsoleCommand({ ...base, dir: "/a\0b" })).toThrow();
    expect(() => buildConsoleCommand({ ...base, shell: "bash;id" })).toThrow();
    expect(() =>
      buildConsoleCommand({ ...base, shell: "/bin/sh -c id" }),
    ).toThrow();
    expect(() => buildConsoleCommand({ ...base, containerId: "-x" })).toThrow();
    expect(() =>
      buildConsoleCommand({ ...base, containerId: "a b" }),
    ).toThrow();
    expect(() =>
      buildConsoleCommand({ ...base, runtime: "rm" as never }),
    ).toThrow();
    expect(isConsoleShell("/usr/local/bin/fish")).toBe(true);
    expect(isConsoleShell("/bin/../sh")).toBe(false);
  });
});

class FakeSocket extends EventEmitter implements ConsoleSocket {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  closedWith: number | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
    this.emit("close");
  }
  frame(type: string, data?: unknown) {
    this.emit("message", Buffer.from(JSON.stringify({ type, data })));
  }
  types() {
    return this.sent.map((m) => m.type);
  }
}

function makeSession(client: FakeClient): ContainerSession {
  return {
    id: "s1",
    client: client.asClient(),
    dispose: () => {},
    hostId: 1,
    userId: "user-1",
    runtime: "docker",
    runtimeVersion: null,
    lastActive: 0,
    activeOperations: 0,
    states: new Map(),
    capabilities: new Map(),
  };
}

function setup(options: { allowed?: boolean; unlocked?: boolean } = {}) {
  const client = new FakeClient([[/exec/, (stream) => void stream]]);
  const session = makeSession(client);
  const sessions = {
    get: (id: string, userId: string) =>
      id === session.id && userId === session.userId ? session : undefined,
    getPending: () => undefined,
    touch: vi.fn(),
  } as unknown as Sessions;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const { handler, closeAll } = createConsoleHandler({
    ctx: {
      rbac: { hasFor: async () => options.allowed ?? true },
    } as never,
    sessions,
    log,
  });
  const ws = new FakeSocket();
  const open = async (userId = "user-1") => {
    await handler({
      userId,
      socket: ws,
      isDataUnlocked: () => options.unlocked ?? true,
    });
  };
  const connect = (extra: Record<string, unknown> = {}) =>
    ws.frame("connect", {
      sessionId: "s1",
      containerId: "abc123def456",
      dir: "/tmp",
      shell: "/bin/sh",
      cols: 100,
      rows: 30,
      ...extra,
    });
  return { client, session, ws, open, connect, closeAll };
}

const stream = (client: FakeClient): FakeStream => client.streams[0]!;

afterEach(() => vi.useRealTimers());

describe("console handler", () => {
  it("closes sockets without the permission or a user", async () => {
    const denied = setup({ allowed: false });
    await denied.open();
    expect(denied.ws.closedWith).toBe(1008);
    const anon = setup();
    await anon.open("");
    expect(anon.ws.closedWith).toBe(1008);
  });

  it("starts the container shell on a pty and relays output and input", async () => {
    const t = setup();
    await t.open();
    t.connect();
    expect(t.client.commands).toHaveLength(1);
    expect(t.client.commands[0]).toContain("'exec' '-it' '-w' '/tmp'");
    expect(t.client.commands[0]).toContain("'/bin/sh'");
    expect(t.client.execOptions[0]).toEqual({
      pty: { term: "xterm-256color", cols: 100, rows: 30 },
    });
    expect(t.ws.types()).toContain("connected");
    expect(t.session.activeOperations).toBe(1);

    stream(t.client).emit("data", Buffer.from("héllo"));
    expect(t.ws.sent.at(-1)).toEqual({ type: "output", data: "héllo" });

    t.ws.frame("input", "ls\r");
    expect(stream(t.client).written.map(String)).toEqual(["ls\r"]);
  });

  it("tells which shell was started: the requested one", async () => {
    const t = setup();
    await t.open();
    t.connect({ shell: "zsh" });
    expect(t.ws.sent.find((m) => m.type === "connected")).toEqual({
      type: "connected",
      data: { shell: "zsh" },
    });
  });

  it("resolves auto to the shell it will exec (bash, else sh)", async () => {
    const t = setup();
    t.client.reply(/command -v bash/, { stdout: "/usr/bin/bash\n" });
    await t.open();
    t.connect({ shell: "auto" });
    await vi.waitFor(() => expect(t.ws.types()).toContain("connected"));
    expect(t.client.commands.at(-1)).toContain("'/usr/bin/bash'");
    expect(t.ws.sent.find((m) => m.type === "connected")?.data).toEqual({
      shell: "/usr/bin/bash",
    });
    expect(t.session.activeOperations).toBe(1);

    const busybox = setup();
    busybox.client.reply(/command -v bash/, { stdout: "/bin/sh\n" });
    await busybox.open();
    busybox.connect({ shell: "auto" });
    await vi.waitFor(() => expect(busybox.ws.types()).toContain("connected"));
    expect(busybox.ws.sent.find((m) => m.type === "connected")?.data).toEqual({
      shell: "/bin/sh",
    });
  });

  it("keeps the fallback script when the probe finds nothing", async () => {
    const t = setup();
    t.client.reply(/command -v bash/, { code: 1 });
    await t.open();
    t.connect({ shell: "auto" });
    await vi.waitFor(() => expect(t.ws.types()).toContain("connected"));
    expect(t.client.commands.at(-1)).toContain("exec bash || exec sh");
    expect(t.ws.sent.find((m) => m.type === "connected")?.data).toEqual({
      shell: null,
    });
  });

  it("reports a quick failure as an early exit and a later one as a normal end", async () => {
    const t = setup();
    await t.open();
    t.connect();
    stream(t.client).emit("close", 127);
    expect(t.ws.sent.at(-1)).toEqual({
      type: "exit",
      data: { code: 127, early: true },
    });
    expect(t.session.activeOperations).toBe(0);

    vi.useFakeTimers();
    t.connect();
    vi.setSystemTime(Date.now() + 10_000);
    t.client.streams[1]!.emit("close", 0);
    expect(t.ws.sent.at(-1)).toEqual({
      type: "exit",
      data: { code: 0, early: false },
    });
  });

  it("closes the channel when the socket closes or on disconnect", async () => {
    const t = setup();
    await t.open();
    t.connect();
    t.ws.close();
    expect(stream(t.client).ended).toBe(true);
    expect(t.session.activeOperations).toBe(0);

    const t2 = setup();
    await t2.open();
    t2.connect();
    t2.ws.frame("disconnect");
    expect(stream(t2.client).ended).toBe(true);
    expect(t2.session.activeOperations).toBe(0);
    expect(t2.ws.types()).not.toContain("exit");
  });

  it("resizes the pty", async () => {
    const t = setup();
    await t.open();
    t.connect();
    const calls: number[][] = [];
    (stream(t.client) as unknown as { setWindow: unknown }).setWindow = (
      ...args: number[]
    ) => calls.push(args);
    t.ws.frame("resize", { cols: 120, rows: 40 });
    t.ws.frame("resize", { cols: 0, rows: 40 });
    expect(calls).toEqual([[40, 120, 40, 120]]);
  });

  it("refuses unknown sessions, bad containers and unsafe shells", async () => {
    const t = setup();
    await t.open();
    t.connect({ sessionId: "other" });
    t.connect({ containerId: "-rf" });
    t.connect({ shell: "bash;id" });
    t.connect({ dir: "/a\nid" });
    expect(t.client.commands).toHaveLength(0);
    expect(t.ws.types().filter((x) => x === "error")).toHaveLength(4);
  });

  it("refuses when the data key is locked", async () => {
    const t = setup({ unlocked: false });
    await t.open();
    t.connect();
    expect(t.client.commands).toHaveLength(0);
    expect(t.ws.types()).toEqual(["error"]);
  });

  it("closes an idle console", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.open();
    t.connect();
    vi.advanceTimersByTime(CONSOLE_IDLE_MS + 1);
    expect(t.ws.sent.at(-1)?.type).toBe("exit");
    expect(stream(t.client).ended).toBe(true);
  });

  it("closeAll ends live consoles", async () => {
    const t = setup();
    await t.open();
    t.connect();
    t.closeAll();
    expect(stream(t.client).ended).toBe(true);
    expect(t.ws.closedWith).toBe(1001);
  });
});

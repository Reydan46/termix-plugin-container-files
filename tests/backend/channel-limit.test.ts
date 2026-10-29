import { afterEach, describe, expect, it, vi } from "vitest";
import tar from "tar-stream";
import {
  MAX_SESSION_CHANNELS,
  channelLoad,
  openChannel,
  runCommand,
} from "../../src/backend/exec";
import { FakeClient, type FakeStream } from "./fake-ssh";
import { startServer, type TestServer } from "./server";

/** A client whose channels stay open until the test destroys them. */
const idle = () => new FakeClient([[/.*/, () => {}]]);
const tick = () => new Promise((r) => setImmediate(r));

describe("exec channel limiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds at most the limit open and hands freed slots to waiters in order", async () => {
    const fake = idle();
    const client = fake.asClient();
    const opened: number[] = [];
    const all = Array.from({ length: MAX_SESSION_CHANNELS + 2 }, (_, i) =>
      openChannel(client, `cmd${i}`).then((c) => {
        opened.push(i);
        return c;
      }),
    );
    await tick();
    expect(fake.commands).toHaveLength(MAX_SESSION_CHANNELS);
    expect(channelLoad(client)).toEqual({
      inUse: MAX_SESSION_CHANNELS,
      queued: 2,
    });

    fake.streams[0].destroy();
    await tick();
    expect(fake.commands.at(-1)).toBe(`cmd${MAX_SESSION_CHANNELS}`);
    fake.streams[1].destroy();
    await tick();
    expect(fake.commands.at(-1)).toBe(`cmd${MAX_SESSION_CHANNELS + 1}`);
    await Promise.all(all);
    expect(channelLoad(client).queued).toBe(0);
  });

  it("lets a nested open use headroom when every regular slot is held", async () => {
    const fake = idle();
    const client = fake.asClient();
    for (let i = 0; i < MAX_SESSION_CHANNELS; i++)
      await openChannel(client, `src${i}`);
    const plain = openChannel(client, "plain");
    const nested = openChannel(client, "dest", undefined, true);
    await tick();
    expect(fake.commands).toContain("dest");
    expect(fake.commands).not.toContain("plain");
    await nested;
    fake.streams[0].destroy();
    fake.streams[1].destroy();
    await tick();
    await plain;
  });

  it("does not let one session's channels block another", async () => {
    const a = idle();
    const b = idle();
    for (let i = 0; i < MAX_SESSION_CHANNELS; i++)
      void openChannel(a.asClient(), "x");
    await tick();
    await openChannel(b.asClient(), "small read");
    expect(b.commands).toEqual(["small read"]);
  });

  it("stops waiting when the signal aborts and frees nothing it never held", async () => {
    const fake = idle();
    const client = fake.asClient();
    for (let i = 0; i < MAX_SESSION_CHANNELS; i++)
      void openChannel(client, "x");
    await tick();
    const controller = new AbortController();
    const waiting = runCommand(client, "late", { signal: controller.signal });
    await tick();
    expect(channelLoad(client).queued).toBe(1);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ status: 499 });
    expect(channelLoad(client)).toEqual({
      inUse: MAX_SESSION_CHANNELS,
      queued: 0,
    });
    expect(fake.commands).not.toContain("late");
  });

  it("gives up waiting after the wait limit", async () => {
    vi.useFakeTimers();
    const fake = idle();
    const client = fake.asClient();
    for (let i = 0; i < MAX_SESSION_CHANNELS; i++)
      void openChannel(client, "x");
    const waiting = openChannel(client, "late");
    const assertion = expect(waiting).rejects.toMatchObject({
      status: 503,
      code: "CHANNEL_BUSY",
    });
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
    expect(channelLoad(client).queued).toBe(0);
  });

  it("releases the slot when the channel fails to open", async () => {
    const client = {
      exec: (_c: string, cb: (e?: Error) => void) => cb(new Error("nope")),
    } as unknown as FakeClient;
    await expect(openChannel(client as never, "x")).rejects.toThrow("nope");
    expect(channelLoad(client as never).inUse).toBe(0);
  });

  it("retries once when sshd refuses the channel", async () => {
    let calls = 0;
    const fake = new FakeClient();
    const exec = fake.exec.bind(fake);
    fake.exec = ((c: string, cb: (e?: Error) => void) => {
      calls++;
      if (calls === 1)
        return cb(new Error("(SSH) Channel open failure: open failed"));
      return exec(c, cb as never);
    }) as never;
    const channel = await openChannel(fake.asClient(), "x");
    expect(calls).toBe(2);
    expect(channel).toBe(fake.streams[0]);
  });

  it("does not retry other errors or retry twice", async () => {
    let calls = 0;
    const failing = (message: string) =>
      ({
        exec: (_c: string, cb: (e?: Error) => void) => {
          calls++;
          cb(new Error(message));
        },
      }) as never;
    await expect(openChannel(failing("Not connected"), "x")).rejects.toThrow();
    expect(calls).toBe(1);
    calls = 0;
    await expect(openChannel(failing("open failed"), "x")).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

describe("download abort", () => {
  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("closes the cp channel and ends the transfer when the client disconnects", async () => {
    server = await startServer();
    await server.request("POST", "/ssh/connect", {
      body: { sessionId: "s1", hostId: 7 },
    });
    const pack = tar.pack();
    pack.entry(
      { name: "big.mp4", size: 100000 } as tar.Header,
      Buffer.alloc(100000),
    );
    pack.finalize();
    const chunks: Buffer[] = [];
    for await (const c of pack) chunks.push(c as Buffer);
    const head = Buffer.concat(chunks).subarray(0, 4096);
    let cp: FakeStream | undefined;
    server.client.reply(/'cp'/, (stream: FakeStream) => {
      cp = stream;
      setImmediate(() => stream.emit("data", head));
    });

    const controller = new AbortController();
    const response = await fetch(
      server.url(
        "/containers/s1/abc123/transfer/download?path=/big.mp4&kind=file&transferId=dl-abort-0001",
      ),
      { headers: { "x-test-user": "user-1" }, signal: controller.signal },
    );
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();

    await vi.waitFor(() => expect(cp?.destroyed).toBe(true));
    await vi.waitFor(async () => {
      const status = await server!.request("GET", "/transfers/dl-abort-0001");
      expect(status.body.state).not.toBe("running");
    });
  });
});

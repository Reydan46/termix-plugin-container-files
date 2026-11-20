import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostOfClient,
  killChannel,
  openChannel,
  reaper,
} from "../../src/backend/exec";
import { FakeClient } from "./fake-ssh";
import { startServer } from "./server";

describe("remote reap on kill", () => {
  afterEach(() => vi.useRealTimers());

  it("tags engine commands and ends the tagged remote processes after a kill", async () => {
    vi.useFakeTimers();
    const fake = new FakeClient([[/.*/, () => {}]]);
    const client = fake.asClient();
    const channel = await openChannel(
      client,
      `PATH="/x:$PATH" docker 'cp' '-' 'c:/tmp'`,
    );
    const tag = /^CF_CH=([0-9a-f]{16}) PATH=/.exec(fake.commands[0])?.[1];
    expect(tag).toBeTruthy();
    killChannel(channel);
    await vi.advanceTimersByTimeAsync(2000);
    const reap = fake.commands.find((c) => c.includes("/proc/"));
    expect(reap).toContain(`CF_CH=${tag}`);
    expect(reap).toContain("kill -KILL");
    expect(reap).toContain(String.raw`tr "\0" "\n"`);
  });

  it("leaves other commands alone and skips the reap for a closed channel", async () => {
    vi.useFakeTimers();
    const fake = new FakeClient([[/.*/, () => {}]]);
    const client = fake.asClient();
    await openChannel(client, "plain");
    expect(fake.commands[0]).toBe("plain");
    const channel = await openChannel(client, `PATH="/x" docker 'ps'`);
    channel.emit("exit", 0);
    channel.emit("close");
    killChannel(channel);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.commands.some((c) => c.includes("/proc/"))).toBe(false);
  });

  it("runs the reap on a connection of its own when a reaper is set", async () => {
    vi.useFakeTimers();
    const fake = new FakeClient([[/.*/, () => {}]]);
    const client = fake.asClient();
    hostOfClient.set(client, 7);
    const run = vi.fn(async () => "killed=0");
    reaper.run = run;
    try {
      const channel = await openChannel(client, `PATH="/x" docker 'cp'`);
      killChannel(channel);
      await vi.advanceTimersByTimeAsync(2000);
      expect(run).toHaveBeenCalledOnce();
      expect(fake.commands.some((c) => c.includes("/proc/"))).toBe(false);
    } finally {
      reaper.run = undefined;
    }
  });

  it("reaps a channel that was destroyed elsewhere and never reported an exit", async () => {
    vi.useFakeTimers();
    const fake = new FakeClient([[/.*/, () => {}]]);
    const client = fake.asClient();
    const channel = await openChannel(client, `PATH="/x" docker 'cp'`);
    channel.destroy();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.commands.some((c) => c.includes("/proc/"))).toBe(true);
  });
});

describe("diagnostics route", () => {
  it("lists the reaps and stray errors", async () => {
    const server = await startServer();
    try {
      const r = await server.request("GET", "/diagnostics");
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body.reaps)).toBe(true);
      expect(Array.isArray(r.body.stray)).toBe(true);
    } finally {
      await server.close();
    }
  });
});

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  newSessionId,
  originOfSession,
  originPrefix,
  via,
} from "../../src/frontend/sessionOrigin";
import {
  pickOrigin,
  planConnect,
  preflightBlock,
} from "../../src/frontend/connectOrigin";

const get = vi.fn();
const post = vi.fn();
const fetchMock = vi.fn();
vi.mock("../../src/frontend/app", () => ({
  getApp: () => ({
    api: { get, post },
    fetch: fetchMock,
    t: (k: string) => k,
  }),
}));

describe("session origin", () => {
  it("encodes the origin in the session id", () => {
    expect(newSessionId("local")).toMatch(/^cf-\d+-/);
    expect(newSessionId("remote")).toMatch(/^cfr-\d+-/);
    expect(newSessionId()).toMatch(/^cf-/);
  });

  it("reads the origin of ids and target keys", () => {
    expect(originOfSession("cf-1-a")).toBe("local");
    expect(originOfSession("cfr-1-a")).toBe("remote");
    expect(originOfSession("cfr-1-a|abc123")).toBe("remote");
    expect(originOfSession("cf-1-a|cfr-looking")).toBe("local");
    expect(originOfSession("")).toBe("local");
  });

  it("prefixes only remote sessions", () => {
    expect(via("cf-1", "/ssh/status")).toBe("/ssh/status");
    expect(via("cfr-1", "/ssh/status")).toBe("/remote/ssh/status");
    expect(via("cfr-1|c", "/containers/x")).toBe("/remote/containers/x");
    expect(originPrefix("local")).toBe("");
    expect(originPrefix("remote")).toBe("/remote");
  });
});

describe("connect origin", () => {
  const base = {
    desktopAvailable: true,
    localHostId: 7,
    resolveOrigin: async () => "remote" as const,
    remoteServerUrl: async () => "https://srv" as string | null,
    remoteHostId: async () => 42 as number | null,
    preflight: async () => ({ connected: false }),
  };

  it("is local on web whatever the host says", async () => {
    const resolve = vi.fn(async () => "remote" as const);
    expect(await pickOrigin(false, resolve)).toBe("local");
    expect(resolve).not.toHaveBeenCalled();
    expect(await pickOrigin(true, resolve)).toBe("remote");
  });

  it("connects locally with the local host id", async () => {
    const plan = await planConnect({
      ...base,
      desktopAvailable: false,
    });
    expect(plan).toMatchObject({ kind: "ready", origin: "local", hostId: 7 });
    if (plan.kind === "ready") expect(plan.sessionId).toMatch(/^cf-/);
  });

  it("connects remotely with the server's host id", async () => {
    const plan = await planConnect(base);
    expect(plan).toMatchObject({ kind: "ready", origin: "remote", hostId: 42 });
    if (plan.kind === "ready") expect(plan.sessionId).toMatch(/^cfr-/);
  });

  it("blocks when the desktop is not linked", async () => {
    const plan = await planConnect({
      ...base,
      remoteServerUrl: async () => null,
    });
    expect(plan).toEqual({ kind: "blocked", key: "remoteNotLinked" });
  });

  it("blocks when the host never synced", async () => {
    const plan = await planConnect({ ...base, remoteHostId: async () => null });
    expect(plan).toEqual({ kind: "blocked", key: "remoteHostMissing" });
  });

  it("maps preflight failures", async () => {
    const fail = (e: object) =>
      planConnect({
        ...base,
        preflight: async () => {
          throw e;
        },
      });
    expect(await fail({ status: 404 })).toEqual({
      kind: "blocked",
      key: "remotePluginMissing",
    });
    expect(await fail({ status: 502, code: "REMOTE_UNAVAILABLE" })).toEqual({
      kind: "blocked",
      key: "remoteUnavailable",
    });
    expect(await fail({ status: 401 })).toEqual({
      kind: "blocked",
      key: "remoteSignedOut",
    });
    // An error that says nothing about the link lets the connect report it.
    expect((await fail({ status: 500 })).kind).toBe("ready");
    expect(preflightBlock({ status: 404, code: "NOT_FOUND" })).toBeNull();
  });
});

describe("containerFsApi routing", () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ data: {} });
    post.mockReset().mockResolvedValue({ data: {} });
    fetchMock.mockReset();
  });

  it("sends remote sessions through /remote", async () => {
    const api = await import("../../src/frontend/containerFsApi");
    await api.sessionApi.status("cfr-1");
    await api.sessionApi.connect("cfr-1", 5);
    await api.fsApi.mkdir("cfr-1|c1", "/x");
    await api.sessionApi.status("cf-1");
    expect(get.mock.calls[0][0]).toBe("/remote/ssh/status");
    expect(post.mock.calls[0][0]).toBe("/remote/ssh/connect");
    expect(post.mock.calls[1][0]).toBe("/remote/containers/cfr-1/c1/fs/mkdir");
    expect(get.mock.calls[1][0]).toBe("/ssh/status");
  });

  it("polls transfers and operations on the given origin", async () => {
    const api = await import("../../src/frontend/containerFsApi");
    await api.transferStatus("t1", "remote");
    await api.transferStatus("t1", "local");
    await api.cancelTransfer("t1", "remote");
    await api.operationStatus("o1", "remote");
    expect(get.mock.calls.map((c) => c[0])).toEqual([
      "/remote/transfers/t1",
      "/transfers/t1",
      "/remote/operations/o1",
    ]);
    expect(post.mock.calls[0][0]).toBe("/remote/transfers/t1/cancel");
  });

  it("builds every call in containerFsApi.ts with via()", () => {
    const src = readFileSync("src/frontend/containerFsApi.ts", "utf8").replace(
      /\s+/g,
      " ",
    );
    const calls = [
      ...src.matchAll(/getApp\(\)\.(?:api\.\w+|fetch)\(([^]{0,140})/g),
      ...src.matchAll(/getApp\(\) \.api\.\w+\(([^]{0,140})/g),
    ];
    expect(calls.length).toBeGreaterThan(20);
    for (const [, args] of calls) {
      expect(args, args).toMatch(
        /^\s*(?:v \? )?(via\(|`\$\{base\(key\)\}|`\$\{originPrefix\(|"\/local\/)/,
      );
    }
  });
});

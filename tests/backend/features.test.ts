import { afterEach, describe, expect, it } from "vitest";
import { nul, startServer, type TestServer } from "./server";
import { FakeClient, type FakeStream } from "./fake-ssh";
import { compress } from "../../src/backend/fs-ops";
import { listDirectory, type ListTarget } from "../../src/backend/fs-list";
import {
  parseGroup,
  parsePasswd,
  parsePrincipals,
} from "../../src/backend/principals";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const FS = "/containers/s1/abc123";
const caps = {
  running: true,
  exec: true,
  findPrintf: true,
  statC: true,
  tools: ["tar", "zip"],
};
const make = (client: FakeClient): ListTarget => ({
  client: client.asClient(),
  runtime: "docker",
  containerId: "abc",
  capabilities: caps,
});

const BOOKS = "/data/ssd/docs/books";
const CYRILLIC = [
  "Василий Горъ (Гозалишвили)",
  "Вероника Рот",
  "Дюна",
  "Cafe\u0301 (NFD)",
];

describe("non-ASCII paths", () => {
  it("lists folders with Cyrillic names, spaces and parentheses", async () => {
    server = await startServer();
    await server.request("POST", "/ssh/connect", {
      body: { sessionId: "s1", hostId: 7 },
    });
    server.client.reply(/-mindepth 1/, {
      stdout: CYRILLIC.map((n) =>
        nul(n, "d", "0", "100.0", "755", "root", "root", "", "d"),
      ).join(""),
    });
    const dir = `${BOOKS}/${CYRILLIC[0]}`;
    const r = await server.raw(
      "GET",
      `${FS}/fs/list?path=${encodeURIComponent(dir)}`,
    );
    expect(r.status).toBe(200);
    const lines = r.buffer
      .toString("utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].meta.path).toBe(dir);
    expect(lines[1].entries.map((e: { name: string }) => e.name)).toEqual(
      CYRILLIC,
    );
    const cmd = server.client.commands.find((c) => c.includes("-mindepth"))!;
    // Passed byte-for-byte as one quoted argument.
    expect(cmd).toContain(`'${dir}'`);
  });

  it("keeps the exact normalization of the path it was given", async () => {
    const client = new FakeClient();
    const nfd = `${BOOKS}/${"Cafe\u0301"}`;
    await listDirectory(make(client), nfd);
    expect(client.commands[0]).toContain(`'${nfd}'`);
    expect(client.commands[0]).not.toContain(`'${nfd.normalize("NFC")}'`);
  });

  it("tells a missing directory from one that cannot be stat'ed", async () => {
    const dir = `${BOOKS}/Дюна`;
    const client = new FakeClient([
      [
        /find -H/,
        {
          code: 44,
          stderr: `ls: cannot access '${dir}': No such file or directory`,
        },
      ],
    ]);
    const err = await listDirectory(make(client), dir).catch((e) => e);
    expect(err).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(err.message).toContain(dir);
    expect(err.message).toContain("No such file or directory");

    const denied = new FakeClient([
      [
        /find -H/,
        { code: 46, stderr: `ls: cannot access '${dir}': Permission denied` },
      ],
    ]);
    await expect(listDirectory(make(denied), dir)).rejects.toMatchObject({
      status: 403,
    });
    // The script itself decides 46 vs 44 from ls, not from `[ -e ]` alone.
    expect(client.commands[0]).toContain("ls -ld");
    expect(client.commands[0]).toContain('*"Permission denied"*) exit 46');
  });
});

describe("compress cleanup", () => {
  const rmCommands = (c: FakeClient) =>
    c.commands.filter((x) => x.includes("rm -f --"));

  it("removes the partial archive when tar fails", async () => {
    const client = new FakeClient([
      [
        /tar -czf/,
        {
          code: 2,
          stderr: "tar: books: Cannot stat: No such file or directory",
        },
      ],
    ]);
    await expect(
      compress(
        make(client),
        "/data/ssd/docs",
        ["books"],
        "/data/ssd/docs/b.tgz",
        "tgz",
      ),
    ).rejects.toMatchObject({ status: 404 });
    const rm = rmCommands(client);
    expect(rm).toHaveLength(1);
    expect(rm[0]).toContain("'/data/ssd/docs/b.tgz'");
  });

  it("removes it on cancel too, but not when the output pre-exists", async () => {
    const controller = new AbortController();
    const client = new FakeClient([
      [
        /tar -cf/,
        (stream: FakeStream) => {
          controller.abort();
          stream.finish("", 0);
        },
      ],
    ]);
    await expect(
      compress(make(client), "/d", ["a"], "/d/a.tar", "tar", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(rmCommands(client)).toHaveLength(1);

    const existing = new FakeClient([[/then exit 17; fi' '_'/, { code: 17 }]]);
    await expect(
      compress(make(existing), "/d", ["a"], "/d/a.tar", "tar"),
    ).rejects.toMatchObject({ status: 409, code: "EXISTS" });
    expect(rmCommands(existing)).toHaveLength(0);

    const raced = new FakeClient([[/tar -cf/, { code: 17 }]]);
    await expect(
      compress(make(raced), "/d", ["a"], "/d/a.tar", "tar"),
    ).rejects.toMatchObject({ code: "EXISTS" });
    expect(rmCommands(raced)).toHaveLength(0);
  });

  it("reports which path is missing and keeps successful runs untouched", async () => {
    const client = new FakeClient();
    await compress(make(client), "/d", ["a b"], "/d/a.tar", "tar");
    expect(rmCommands(client)).toHaveLength(0);
    const script = client.commands.at(-1)!;
    expect(script).toContain('echo "$d/$n: No such file or directory"');
    expect(script).toContain("'/d' '/d/a.tar' 'tar' 'a b'");
  });
});

describe("principals", () => {
  it("parses passwd and group files robustly", () => {
    const users = parsePasswd(
      [
        "# comment",
        "",
        "root:x:0:0:root:/root:/bin/bash",
        "nobody:x:65534:65534::/:/sbin/nologin",
        "broken line",
        "x:x:abc:1::/:/bin/sh",
        "short:x:5:6",
        "",
      ].join("\r\n"),
    );
    expect(users).toEqual([
      { name: "root", uid: 0, gid: 0, home: "/root" },
      { name: "nobody", uid: 65534, gid: 65534, home: "/" },
      { name: "short", uid: 5, gid: 6 },
    ]);
    expect(parseGroup("root:x:0:\n#c\nstaff:x:50:a,b\nbad:x\n")).toEqual([
      { name: "root", gid: 0 },
      { name: "staff", gid: 50 },
    ]);
    expect(parsePrincipals("")).toEqual({ users: [], groups: [] });
  });

  it("serves users and groups, and empty lists when unreadable", async () => {
    server = await startServer();
    await server.request("POST", "/ssh/connect", {
      body: { sessionId: "s1", hostId: 7 },
    });
    server.client.reply(/cf-groups/, {
      stdout: "root:x:0:0:r:/root:/bin/sh\n\n--cf-groups--\nroot:x:0:\n",
    });
    const ok = await server.request("GET", `${FS}/fs/principals`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      users: [{ name: "root", uid: 0, gid: 0, home: "/root" }],
      groups: [{ name: "root", gid: 0 }],
    });

    server.client.reply(/cf-groups/, { code: 1, stderr: "boom" });
    const bad = await server.request("GET", `${FS}/fs/principals`);
    expect(bad.status).toBe(200);
    expect(bad.body).toEqual({ users: [], groups: [] });
  });
});

describe("container state and actions", () => {
  async function stateful() {
    let status = "running";
    const s = await startServer();
    await s.request("POST", "/ssh/connect", {
      body: { sessionId: "s1", hostId: 7 },
    });
    s.client.reply(/'inspect'/, (stream: FakeStream) =>
      stream.finish(
        `abc123def|${status === "running" || status === "paused"}|${status}|/web\n`,
      ),
    );
    for (const [action, next] of [
      ["stop", "exited"],
      ["start", "running"],
      ["restart", "running"],
      ["pause", "paused"],
      ["unpause", "running"],
    ] as const) {
      s.client.reply(
        new RegExp(`'${action}' 'abc123'`),
        (stream: FakeStream) => {
          status = next;
          stream.finish("");
        },
      );
    }
    return s;
  }

  it("reports a state that follows the container without reconnecting", async () => {
    server = await stateful();
    const up = await server.request("GET", `${FS}/state`);
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({
      running: true,
      state: "running",
      name: "web",
      capabilities: { running: true, exec: true },
    });

    // Stopped behind our back, within the 5s inspect cache window.
    server.client.reply(/'inspect'/, {
      stdout: "abc123def|false|exited|/web\n",
    });
    const down = await server.request("GET", `${FS}/state`);
    expect(down.body).toMatchObject({
      running: false,
      state: "exited",
      capabilities: { running: false, exec: false },
    });
    const caps = await server.request("GET", `${FS}/capabilities`);
    expect(caps.body).toMatchObject({ running: false, exec: false });

    server.client.reply(/'inspect'/, {
      stdout: "abc123def|true|running|/web\n",
    });
    const again = await server.request("GET", `${FS}/state`);
    expect(again.body.capabilities).toMatchObject({
      running: true,
      exec: true,
    });
  });

  it("runs actions through the engine and returns the new state", async () => {
    server = await stateful();
    const stop = await server.request("POST", `${FS}/action`, {
      body: { action: "stop" },
    });
    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({
      success: true,
      running: false,
      state: "exited",
      capabilities: { exec: false },
    });
    expect(
      server.client.commands.some((c) => c.endsWith(" docker 'stop' 'abc123'")),
    ).toBe(true);

    const start = await server.request("POST", `${FS}/action`, {
      body: { action: "start" },
    });
    expect(start.body).toMatchObject({ running: true, state: "running" });
    expect(start.body.capabilities.exec).toBe(true);

    const pause = await server.request("POST", `${FS}/action`, {
      body: { action: "pause" },
    });
    expect(pause.body).toMatchObject({ running: false, state: "paused" });
  });

  it("rejects unknown actions and surfaces engine errors", async () => {
    server = await stateful();
    const before = server.client.commands.length;
    for (const action of ["kill", "rm -f x", "", undefined]) {
      const r = await server.request("POST", `${FS}/action`, {
        body: { action },
      });
      expect(r.status).toBe(400);
    }
    expect(server.client.commands.length).toBe(before);

    server.client.reply(/'start' 'abc123'/, {
      code: 1,
      stderr: "Error: port is already allocated",
    });
    const r = await server.request("POST", `${FS}/action`, {
      body: { action: "start" },
    });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: "ACTION_FAILED" });
    expect(r.body.error).toContain("port is already allocated");
  });

  it("refuses the new routes without the use permission", async () => {
    server = await startServer({ permissions: [] });
    for (const [method, path] of [
      ["GET", `${FS}/state`],
      ["POST", `${FS}/action`],
      ["GET", `${FS}/fs/principals`],
    ]) {
      const r = await server.request(method, path, {
        body: { action: "stop" },
      });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
  });
});

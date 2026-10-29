import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { FakeClient, type FakeStream } from "./fake-ssh";
import { nul, startServer, type TestServer } from "./server";
import type { ListTarget } from "../../src/backend/fs-list";
import {
  APPEND_TOOLS,
  appendTempPaths,
  appendToArchive,
  canAppendTo,
} from "../../src/backend/archive-append";
import { clearArchiveCache } from "../../src/backend/archive";

let server: TestServer | null = null;
afterEach(async () => {
  clearArchiveCache();
  await server?.close();
  server = null;
});

const target = (client: FakeClient, tools = ["tar", "zip"]): ListTarget => ({
  client: client.asClient(),
  runtime: "docker",
  containerId: "abc",
  capabilities: {
    running: true,
    exec: true,
    findPrintf: true,
    statC: true,
    tools,
  },
});

const appendCommands = (c: FakeClient) =>
  c.commands.filter((x) => x.includes("mv -f --"));
const rmCommands = (c: FakeClient) =>
  c.commands.filter((x) => x.includes("rm -f --") && !x.includes("mv -f"));

describe("append command construction", () => {
  it.each([
    ["/d/a.zip", "zip"],
    ["/d/a.tar", "tar"],
    ["/d/a.tar.gz", "tgz"],
    ["/d/a.tgz", "tgz"],
    ["/d/a.tar.bz2", "tbz"],
    ["/d/a.tar.xz", "txz"],
  ])(
    "passes %s as positional arguments to a constant script",
    async (path, kind) => {
      const client = new FakeClient();
      await appendToArchive(target(client), path, "/src dir", [
        "it's; rm -rf x",
        "b",
      ]);
      const [cmd] = appendCommands(client);
      expect(cmd).toBeDefined();
      expect(cmd).toContain(`'${path}' '${kind}'`);
      expect(cmd).toContain("'/src dir'");
      expect(cmd).toContain("'it'\\''s; rm -rf x'");
      expect(cmd).toContain(kind === "zip" ? "zip -qgr" : "tar -rf");
    },
  );

  it("works on a copy and replaces the original with one mv", async () => {
    const client = new FakeClient();
    await appendToArchive(target(client), "/d/a.zip", "/d", ["x"]);
    const [cmd] = appendCommands(client);
    expect(cmd).toContain('cp -p -- "$a" "$w"');
    expect(cmd.indexOf("zip -qgr")).toBeLessThan(cmd.indexOf("mv -f --"));
    expect(cmd).toContain("trap cleanup EXIT");
    expect(cmd).toMatch(/'\/d\/\.cf-part-[0-9a-f]{8}-a\.zip'/);
  });

  it("rewrites compressed tars through a temporary tar", () => {
    const { work, scratch } = appendTempPaths(
      "/d/a.tar.xz",
      "txz",
      "abcdef12-x",
    );
    expect(work).toMatch(/^\/d\/\.cf-part-[^/]+-a\.tar\.xz$/);
    expect(scratch).toMatch(/^\/d\/\.cf-part-[^/]+-a\.tar\.xz\.tar$/);
    expect(appendTempPaths("/d/a.tar", "tar").scratch).toBe("");
  });

  it("knows which names accept an append", () => {
    expect(canAppendTo("x.TAR.GZ")).toBe(true);
    expect(canAppendTo("x.txt")).toBe(false);
    expect(APPEND_TOOLS.zip).toBe("zip");
    expect(APPEND_TOOLS.tgz).toBe("tar");
  });
});

describe("append refusals", () => {
  it("refuses a source that is or contains the archive", async () => {
    const client = new FakeClient();
    await expect(
      appendToArchive(target(client), "/d/a.zip", "/d", ["a.zip"]),
    ).rejects.toMatchObject({ code: "INCLUDES_ARCHIVE" });
    await expect(
      appendToArchive(target(client), "/d/sub/a.zip", "/d", ["sub"]),
    ).rejects.toMatchObject({ code: "INCLUDES_ARCHIVE" });
    await expect(
      appendToArchive(target(client), "/x.zip", "/", ["."]),
    ).rejects.toMatchObject({ code: "INCLUDES_ARCHIVE" });
    expect(client.commands).toHaveLength(0);
  });

  it("rejects non-archives, empty selections and missing tools", async () => {
    const client = new FakeClient();
    await expect(
      appendToArchive(target(client), "/d/a.txt", "/d", ["x"]),
    ).rejects.toMatchObject({ code: "APPEND_UNSUPPORTED" });
    await expect(
      appendToArchive(target(client), "/d/a.zip", "/d", []),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      appendToArchive(target(client, ["tar"]), "/d/a.zip", "/d", ["x"]),
    ).rejects.toMatchObject({ code: "NO_TOOL" });
    expect(client.commands).toHaveLength(0);
  });

  it.each([
    [19, 501, "APPEND_UNSUPPORTED", "busybox-tar"],
    [20, 501, "APPEND_UNSUPPORTED", "no-compressor"],
    [23, 501, "APPEND_UNSUPPORTED", "symlink"],
    [21, 403, "ARCHIVE_READ_ONLY", undefined],
  ])("maps exit %i to %s", async (exit, status, code, reason) => {
    const client = new FakeClient([[/mv -f --/, { code: exit }]]);
    const error = await appendToArchive(target(client), "/d/a.tar.gz", "/d", [
      "x",
    ]).catch((e) => e);
    expect(error).toMatchObject({ status, code });
    if (reason && reason !== "no-compressor")
      expect(error.details).toEqual({ reason });
  });

  it("does not read zip's exit 18 (cannot open a source) as a modified file", async () => {
    const client = new FakeClient([
      [/mv -f --/, { code: 18, stderr: "zip warning: could not open x" }],
    ]);
    const error = await appendToArchive(target(client), "/d/a.zip", "/d", [
      "x",
    ]).catch((e) => e);
    expect(error).toMatchObject({ status: 500, code: "EXEC_FAILED" });
  });

  it.each([
    ["/d/a.tar.gz", "gzip"],
    ["/d/a.tgz", "gzip"],
    ["/d/a.tar.bz2", "bzip2"],
    ["/d/a.tbz2", "bzip2"],
    ["/d/a.tar.xz", "xz"],
    ["/d/a.txz", "xz"],
  ])("names the missing compressor for %s", async (path, tool) => {
    const client = new FakeClient([[/mv -f --/, { code: 20 }]]);
    const error = await appendToArchive(target(client, ["tar"]), path, "/d", [
      "x",
    ]).catch((e) => e);
    expect(error).toMatchObject({ status: 501, code: "APPEND_UNSUPPORTED" });
    expect(error.details).toEqual({ reason: "no-compressor", tool });
    expect(error.message).toContain(tool);
  });

  it("accepts every archive extension with only tar installed (tar kinds)", async () => {
    for (const path of [
      "/d/a.tar.gz",
      "/d/a.tgz",
      "/d/a.tar.bz2",
      "/d/a.tbz2",
      "/d/a.tar.xz",
      "/d/a.txz",
      "/d/a.tar",
    ]) {
      const client = new FakeClient();
      await appendToArchive(target(client, ["tar"]), path, "/d", ["x"]);
      expect(appendCommands(client)).toHaveLength(1);
    }
  });

  it("reports missing sources like other ops", async () => {
    const client = new FakeClient([
      [/mv -f --/, { code: 1, stderr: "/d/x: No such file or directory" }],
    ]);
    await expect(
      appendToArchive(target(client), "/d/a.zip", "/d", ["x"]),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("append cleanup", () => {
  it("removes the temp files after a failure", async () => {
    const client = new FakeClient([[/mv -f --/, { code: 2, stderr: "boom" }]]);
    await expect(
      appendToArchive(target(client), "/d/a.tar.gz", "/d", ["x"]),
    ).rejects.toBeDefined();
    const rm = rmCommands(client);
    expect(rm).toHaveLength(1);
    expect(rm[0]).toMatch(/\.cf-part-[0-9a-f]{8}-a\.tar\.gz'/);
    expect(rm[0]).toMatch(/\.cf-part-[0-9a-f]{8}-a\.tar\.gz\.tar'/);
  });

  it("removes them on cancel", async () => {
    const controller = new AbortController();
    const client = new FakeClient([
      [
        /mv -f --/,
        (stream: FakeStream) => {
          controller.abort();
          stream.finish("", 0);
        },
      ],
    ]);
    await expect(
      appendToArchive(target(client), "/d/a.tar", "/d", ["x"], {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(rmCommands(client)).toHaveLength(1);
  });

  it("leaves nothing to clean up after a success", async () => {
    const client = new FakeClient();
    await appendToArchive(target(client), "/d/a.tar", "/d", ["x"]);
    expect(rmCommands(client)).toHaveLength(0);
  });
});

describe("append route", () => {
  const FS = "/containers/s1/abc123";
  const connect = (s: TestServer) =>
    s.request("POST", "/ssh/connect", { body: { sessionId: "s1", hostId: 7 } });

  it("runs the op and drops cached archive listings", async () => {
    server = await startServer();
    await connect(server);
    server.client.reply(/tar -tv/, {
      stdout:
        "-rw-r--r-- user/staff      120 2024-03-05 10:20:30 ./readme.txt\n",
    });
    server.client.reply(/find -H/, {
      stdout: nul("a.tar", "f", "9", "100.0", "644", "root", "root", "", "f"),
    });
    const count = () =>
      server!.client.commands.filter((c) => c.includes("tar -tv")).length;
    const list = () =>
      server!.request(
        "GET",
        `${FS}/fs/archive/list?archive=${encodeURIComponent("/d/a.tar")}&path=/`,
      );
    await list();
    await list();
    const before = count();
    expect(before).toBeGreaterThan(0);
    const r = await server.request("POST", `${FS}/fs/append`, {
      body: { archive: "/d/a.tar", dir: "/d", names: ["x y"] },
    });
    expect(r.status).toBe(200);
    expect(server.client.commands.at(-1)).toContain("'x y'");
    await list();
    expect(count()).toBeGreaterThan(before);
  });

  it("answers APPEND_UNSUPPORTED with its reason", async () => {
    server = await startServer();
    await connect(server);
    server.client.reply(/mv -f --/, { code: 19 });
    const r = await server.request("POST", `${FS}/fs/append`, {
      body: { archive: "/d/a.tar", dir: "/d", names: ["x"] },
    });
    expect(r.status).toBe(501);
    expect(r.body.code).toBe("APPEND_UNSUPPORTED");
    expect(JSON.stringify(r.body)).toContain("busybox-tar");
  });

  it("declares the op in its @openapi block", async () => {
    const src = await readFile("src/backend/routes.ts", "utf8");
    expect(src).toMatch(/compress, append, extract/);
    expect(src).toMatch(/append: add files to an existing archive/);
  });
});

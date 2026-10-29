import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { FakeClient, type FakeStream } from "./fake-ssh";
import { nul, startServer, type TestServer } from "./server";
import type { ListTarget } from "../../src/backend/fs-list";
import {
  canDeleteFrom,
  DELETE_SCRIPT,
  deleteFromArchive,
  deleteUnsupported,
} from "../../src/backend/archive-delete";
import { clearArchiveCache } from "../../src/backend/archive";
import {
  computeDeleteSupport,
  parseProbe,
} from "../../src/backend/capabilities";

let server: TestServer | null = null;
afterEach(async () => {
  clearArchiveCache();
  await server?.close();
  server = null;
});

const TAR_OUT = `drwxr-xr-x root/root         0 2024-03-05 10:20:30 ./
-rw-r--r-- user/staff      120 2024-03-05 10:20:30 ./readme.txt
drwxr-xr-x root/root         0 2024-03-05 10:20:30 ./sub/
-rwxr-xr-x root/root       900 2024-03-06 01:02:03 ./sub/run it.sh
-rw-r--r-- root/root         7 2024-03-05 10:20:30 ./sub/b.txt
`;

const ONLY_ONE = `-rw-r--r-- user/staff      120 2024-03-05 10:20:30 ./readme.txt
`;

const ZIP_OUT = `Archive:  /a.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
        0  2024-03-05 10:20   dir/
       12  2024-03-05 10:20   dir/a b.txt
      100  2024-03-05 10:21   top.txt
---------                     -------
      112                     3 files
`;

const SEVENZ_OUT = `Path = readme.txt
Folder = -
Size = 120
Attributes = A -rw-r--r--

Path = sub
Folder = +
Size = 0
Attributes = D drwxr-xr-x

Path = sub/b.txt
Folder = -
Size = 7
Attributes = A -rw-r--r--
`;

const target = (
  client: FakeClient,
  tools = ["tar", "zip", "unzip", "gzip", "bzip2", "xz", "zstd", "7zz"],
  tarFlavor?: "gnu" | "busybox" | "bsd",
): ListTarget => ({
  client: client.asClient(),
  runtime: "docker",
  containerId: "abc",
  capabilities: {
    running: true,
    exec: true,
    findPrintf: true,
    statC: true,
    tools,
    ...(tarFlavor ? { tarFlavor } : {}),
  },
});

const stat = (name = "a") =>
  nul(name, "f", "999", "100.0", "644", "root", "root", "", "f");

/** A container whose archive lists as `listing` whatever tool reads it. */
const withListing = (listing: string, extra: Array<[RegExp, any]> = []) =>
  new FakeClient([
    ...extra,
    [/-maxdepth 0/, { stdout: stat() }],
    [
      /unzip -l|-slt -ba|tar -tv|zstd -dc -- "\$1" \| tar -tvf/,
      { stdout: listing },
    ],
  ]);

const deletes = (c: FakeClient) =>
  c.commands.filter((x) => x.includes("mv -f --"));
const rmCommands = (c: FakeClient) =>
  c.commands.filter((x) => x.includes("rm -f --") && !x.includes("mv -f"));

describe("delete command construction", () => {
  it.each([
    ["/d/a.tar", "tar", TAR_OUT],
    ["/d/a.tar.gz", "tgz", TAR_OUT],
    ["/d/a.tgz", "tgz", TAR_OUT],
    ["/d/a.tar.bz2", "tbz", TAR_OUT],
    ["/d/a.tar.xz", "txz", TAR_OUT],
    ["/d/a.tar.zst", "tzst", TAR_OUT],
    ["/d/a.tzst", "tzst", TAR_OUT],
    ["/d/a.7z", "7z", SEVENZ_OUT],
  ])(
    "passes %s as positional arguments to a constant script",
    async (path, kind, listing) => {
      const client = withListing(listing);
      await deleteFromArchive(target(client), path, ["/readme.txt"]);
      const [cmd] = deletes(client);
      expect(cmd).toBeDefined();
      expect(cmd).toContain(`'${path}' '${kind}'`);
      expect(cmd).toContain(DELETE_SCRIPT.split("\n")[0].slice(0, 20));
      expect(cmd).toMatch(/'(\.\/)?readme\.txt'$/);
    },
  );

  it("deletes from a zip with the stored names, folder contents included", async () => {
    const client = withListing(ZIP_OUT);
    await deleteFromArchive(target(client), "/d/a.zip", ["/dir"]);
    const [cmd] = deletes(client);
    expect(cmd).toContain("'/d/a.zip' 'zip'");
    expect(cmd).toContain("'dir/'");
    expect(cmd).toContain('zip -q -d "$w" -- "$@"');
    expect(cmd).toContain('r/*"');
  });

  it("quotes a hostile name as one argument", async () => {
    const listing = `-rw-r--r-- u/g 5 2024-03-05 10:20:30 ./it's; rm -rf x\n${ONLY_ONE}`;
    const client = withListing(listing);
    await deleteFromArchive(target(client), "/d/a.tar", ["/it's; rm -rf x"]);
    const [cmd] = deletes(client);
    expect(cmd).toContain("'./it'\\''s; rm -rf x'");
    expect(DELETE_SCRIPT).not.toContain("rm -rf x");
  });

  it("works on a copy and replaces the original with one mv", async () => {
    const client = withListing(TAR_OUT);
    await deleteFromArchive(target(client), "/d/a.tar", ["/sub"]);
    const [cmd] = deletes(client);
    expect(cmd).toContain('cp -p -- "$a" "$w"');
    expect(cmd.indexOf("tar --delete")).toBeLessThan(cmd.indexOf("mv -f --"));
    expect(cmd).toContain("trap cleanup EXIT");
    expect(cmd).toContain("HUP INT TERM");
    expect(cmd).toContain('chmod "$m"');
    expect(cmd).toContain('chown "$o"');
    expect(cmd).toMatch(/'\/d\/\.cf-part-[0-9a-f]{8}-a\.tar'/);
  });

  it("deletes a folder as its own name so tar and 7z take its contents", async () => {
    const client = withListing(TAR_OUT);
    await deleteFromArchive(target(client), "/d/a.tar", ["/sub", "/sub/b.txt"]);
    const [cmd] = deletes(client);
    expect(cmd).toMatch(/'\.\/sub\/?'$/);
    expect(cmd).not.toContain("b.txt'");
  });

  it("rewrites compressed tars through a decompressed copy", async () => {
    const client = withListing(TAR_OUT);
    await deleteFromArchive(target(client), "/d/a.tar.xz", ["/readme.txt"]);
    const [cmd] = deletes(client);
    expect(cmd).toContain("'xz' ");
    expect(cmd).toMatch(/\.cf-part-[0-9a-f]{8}-a\.tar\.xz\.tar'/);
    expect(DELETE_SCRIPT).toContain('"$c" -dc -- "$a" > "$x"');
    expect(DELETE_SCRIPT).toContain('"$c" -c -- "$x" > "$w"');
  });

  it("prefers 7zz and falls back to the other builds", async () => {
    const a = withListing(SEVENZ_OUT);
    await deleteFromArchive(target(a, ["7zr", "7za", "7zz"]), "/d/a.7z", [
      "/readme.txt",
    ]);
    expect(deletes(a)[0]).toContain("'7zz' 'readme.txt'");
    const b = withListing(SEVENZ_OUT);
    await deleteFromArchive(target(b, ["7za"]), "/d/a.7z", ["/readme.txt"]);
    expect(deletes(b)[0]).toContain("'7za' 'readme.txt'");
    expect(DELETE_SCRIPT).toContain('"$c" d -y -- "$w" "$@" </dev/null');
  });

  it("lists once, then asks for nothing it cannot name", async () => {
    const client = withListing(TAR_OUT);
    await expect(
      deleteFromArchive(target(client), "/d/a.tar", ["/nope"]),
    ).rejects.toMatchObject({ status: 404 });
    expect(deletes(client)).toHaveLength(0);
  });
});

describe("delete refusals", () => {
  it("rejects empty selections, non-archives and the root", async () => {
    const client = withListing(TAR_OUT);
    await expect(
      deleteFromArchive(target(client), "/d/a.tar", []),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      deleteFromArchive(target(client), "/d/a.txt", ["/x"]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      deleteFromArchive(target(client), "/d/a.tar", ["/"]),
    ).rejects.toMatchObject({ status: 400 });
    expect(deletes(client)).toHaveLength(0);
  });

  it("explains that rar and single files cannot be changed", async () => {
    const client = new FakeClient();
    const rar = await deleteFromArchive(target(client, ["unrar"]), "/d/a.rar", [
      "/x",
    ]).catch((e) => e);
    expect(rar).toMatchObject({ status: 501, code: "DELETE_UNSUPPORTED" });
    expect(rar.details).toEqual({ reason: "rar" });
    const gz = await deleteFromArchive(
      target(client, ["gzip"]),
      "/d/a.txt.gz",
      ["/x"],
    ).catch((e) => e);
    expect(gz).toMatchObject({ status: 501, code: "DELETE_UNSUPPORTED" });
    expect(gz.details).toEqual({ reason: "single-file" });
    expect(client.commands).toHaveLength(0);
  });

  it("refuses to leave an archive empty", async () => {
    const client = withListing(ONLY_ONE);
    await expect(
      deleteFromArchive(target(client), "/d/a.tar", ["/readme.txt"]),
    ).rejects.toMatchObject({ status: 409, code: "ARCHIVE_WOULD_BE_EMPTY" });
    expect(deletes(client)).toHaveLength(0);
  });

  it("refuses everything when a folder holds all of it", async () => {
    const client = withListing(ZIP_OUT);
    await expect(
      deleteFromArchive(target(client), "/d/a.zip", ["/dir", "/top.txt"]),
    ).rejects.toMatchObject({ code: "ARCHIVE_WOULD_BE_EMPTY" });
  });

  it("refuses names the archive tool reads as patterns", async () => {
    const zip = withListing(`${ZIP_OUT.replace("top.txt", "we[ir]d*.txt")}`);
    await expect(
      deleteFromArchive(target(zip), "/d/a.zip", ["/we[ir]d*.txt"]),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_NAME" });
    const sevenZ = withListing(SEVENZ_OUT.replace("readme.txt", "a?b.txt"));
    await expect(
      deleteFromArchive(target(sevenZ), "/d/a.7z", ["/a?b.txt"]),
    ).rejects.toMatchObject({ status: 400 });
    expect(deletes(zip)).toHaveLength(0);
    expect(deletes(sevenZ)).toHaveLength(0);
  });

  it.each([
    ["/d/a.zip", ["tar"], "zip"],
    ["/d/a.7z", ["tar", "zip"], "7z"],
    ["/d/a.tar", ["zip"], "tar"],
  ])("names the missing tool for %s", async (path, tools, tool) => {
    const client = new FakeClient();
    const error = await deleteFromArchive(target(client, tools), path, [
      "/x",
    ]).catch((e) => e);
    expect(error).toMatchObject({ status: 501, code: "NO_TOOL" });
    expect(error.details).toEqual({ tool });
    expect(client.commands).toHaveLength(0);
  });

  it.each([
    ["/d/a.tar.gz", "gzip"],
    ["/d/a.tar.bz2", "bzip2"],
    ["/d/a.tar.xz", "xz"],
    ["/d/a.tzst", "zstd"],
  ])("names the missing compressor for %s", async (path, tool) => {
    const client = new FakeClient();
    const error = await deleteFromArchive(target(client, ["tar"]), path, [
      "/x",
    ]).catch((e) => e);
    expect(error).toMatchObject({ status: 501, code: "DELETE_UNSUPPORTED" });
    expect(error.details).toEqual({ reason: "no-compressor", tool });
    expect(error.message).toContain(`${tool} is not installed`);
    expect(client.commands).toHaveLength(0);
  });

  it.each(["busybox", "bsd"] as const)(
    "refuses tar kinds with a %s tar but not zip or 7z",
    async (flavor) => {
      const client = withListing(TAR_OUT);
      const error = await deleteFromArchive(
        target(client, undefined, flavor),
        "/d/a.tar",
        ["/readme.txt"],
      ).catch((e) => e);
      expect(error).toMatchObject({ status: 501, code: "DELETE_UNSUPPORTED" });
      expect(error.details).toEqual({ reason: "gnu-tar" });
      expect(client.commands).toHaveLength(0);
      const zip = withListing(ZIP_OUT);
      await deleteFromArchive(target(zip, undefined, flavor), "/d/a.zip", [
        "/top.txt",
      ]);
      expect(deletes(zip)).toHaveLength(1);
    },
  );

  it.each([
    [19, 501, "DELETE_UNSUPPORTED", "gnu-tar"],
    [20, 501, "DELETE_UNSUPPORTED", "no-compressor"],
    [23, 501, "DELETE_UNSUPPORTED", "symlink"],
    [21, 403, "ARCHIVE_READ_ONLY", undefined],
    [24, 409, "ARCHIVE_WOULD_BE_EMPTY", undefined],
    [12, 404, "NOT_FOUND", undefined],
  ])("maps exit %i to %i %s", async (exit, status, code, reason) => {
    const client = withListing(TAR_OUT, [[/mv -f --/, { code: exit }]]);
    const error = await deleteFromArchive(target(client), "/d/a.tar.gz", [
      "/readme.txt",
    ]).catch((e) => e);
    expect(error).toMatchObject({ status, code });
    if (reason && reason !== "no-compressor")
      expect(error.details).toEqual({ reason });
  });

  it("reports other failures like the other ops", async () => {
    const client = withListing(TAR_OUT, [
      [/mv -f --/, { code: 2, stderr: "tar: boom" }],
    ]);
    await expect(
      deleteFromArchive(target(client), "/d/a.tar", ["/readme.txt"]),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("builds the unsupported error with the tool when known", () => {
    const e = deleteUnsupported("no-compressor", "zstd");
    expect(e.details).toEqual({ reason: "no-compressor", tool: "zstd" });
    expect(deleteUnsupported("rar").message).toContain("RAR");
  });

  it("knows which kinds can be deleted from", () => {
    for (const k of ["zip", "tar", "tgz", "tbz", "txz", "tzst", "7z"] as const)
      expect(canDeleteFrom(k)).toBe(true);
    for (const k of ["rar", "gz", "bz2", "xz", "zst", null] as const)
      expect(canDeleteFrom(k)).toBe(false);
  });
});

describe("delete cleanup", () => {
  it("removes the temp files after a failure", async () => {
    const client = withListing(TAR_OUT, [
      [/mv -f --/, { code: 2, stderr: "x" }],
    ]);
    await expect(
      deleteFromArchive(target(client), "/d/a.tar.gz", ["/readme.txt"]),
    ).rejects.toBeDefined();
    const rm = rmCommands(client);
    expect(rm).toHaveLength(1);
    expect(rm[0]).toMatch(/\.cf-part-[0-9a-f]{8}-a\.tar\.gz'/);
    expect(rm[0]).toMatch(/\.cf-part-[0-9a-f]{8}-a\.tar\.gz\.tar'/);
  });

  it("removes them on cancel", async () => {
    const controller = new AbortController();
    const client = withListing(TAR_OUT, [
      [
        /mv -f --/,
        (stream: FakeStream) => {
          controller.abort();
          stream.finish("", 0);
        },
      ],
    ]);
    await expect(
      deleteFromArchive(target(client), "/d/a.tar", ["/readme.txt"], {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(rmCommands(client)).toHaveLength(1);
  });

  it("leaves nothing to clean up after a success", async () => {
    const client = withListing(TAR_OUT);
    await deleteFromArchive(target(client), "/d/a.tar", ["/readme.txt"]);
    expect(rmCommands(client)).toHaveLength(0);
  });
});

describe("delete support probe", () => {
  const every = ["tar", "zip", "gzip", "bzip2", "xz", "zstd", "7zz"];

  it("GNU tar with every tool allows every kind", () => {
    const s = computeDeleteSupport(every, "gnu");
    expect(Object.values(s).every((v) => v.ok)).toBe(true);
    expect(Object.keys(s).sort()).toEqual(
      ["7z", "tar", "tbz", "tgz", "tzst", "txz", "zip"].sort(),
    );
  });

  it("treats a tar of unknown flavour as workable", () => {
    expect(computeDeleteSupport(["tar"], undefined).tar).toEqual({ ok: true });
  });

  it.each(["busybox", "bsd"] as const)("a %s tar needs GNU tar", (flavor) => {
    const s = computeDeleteSupport(every, flavor);
    expect(s.zip).toEqual({ ok: true });
    expect(s["7z"]).toEqual({ ok: true });
    for (const k of ["tar", "tgz", "tbz", "txz", "tzst"] as const)
      expect(s[k]).toEqual({ ok: false, reason: "gnu-tar" });
  });

  it("names a missing tool for its own kind only", () => {
    const s = computeDeleteSupport(["tar", "xz"], "gnu");
    expect(s.tar).toEqual({ ok: true });
    expect(s.txz).toEqual({ ok: true });
    expect(s.tgz).toEqual({ ok: false, reason: "no-tool", tool: "gzip" });
    expect(s.tzst).toEqual({ ok: false, reason: "no-tool", tool: "zstd" });
    expect(s.zip).toEqual({ ok: false, reason: "no-tool", tool: "zip" });
    expect(s["7z"]).toEqual({ ok: false, reason: "no-tool", tool: "7z" });
    expect(computeDeleteSupport([], undefined).tar).toEqual({
      ok: false,
      reason: "no-tool",
      tool: "tar",
    });
  });

  it("is part of the probe result only when exec works", () => {
    const out = "tool:tar\ntool:zip\ntarFlavor:gnu\nprobed\n";
    expect(parseProbe(out, true).deleteSupport?.zip).toEqual({ ok: true });
    expect(parseProbe("", false).deleteSupport).toBeUndefined();
  });
});

describe("delete route", () => {
  const FS = "/containers/s1/abc123";
  const connect = (s: TestServer) =>
    s.request("POST", "/ssh/connect", { body: { sessionId: "s1", hostId: 7 } });

  it("runs the op and drops cached archive listings", async () => {
    server = await startServer();
    await connect(server);
    server.client.reply(/tar -tv/, { stdout: TAR_OUT });
    server.client.reply(/find -H/, { stdout: stat("a.tar") });
    const count = () =>
      server!.client.commands.filter((c) => c.includes("tar -tv")).length;
    const list = () =>
      server!.request(
        "GET",
        `${FS}/fs/archive/list?archive=${encodeURIComponent("/d/a.tar")}&path=/`,
      );
    await list();
    const before = count();
    expect(before).toBeGreaterThan(0);
    const r = await server.request("POST", `${FS}/fs/archive-delete`, {
      body: { archive: "/d/a.tar", entries: ["/sub"] },
    });
    expect(r.status).toBe(200);
    expect(server.client.commands.some((c) => c.includes("tar --delete"))).toBe(
      true,
    );
    await list();
    expect(count()).toBeGreaterThan(before);
  });

  it("needs a list of entries", async () => {
    server = await startServer();
    await connect(server);
    const r = await server.request("POST", `${FS}/fs/archive-delete`, {
      body: { archive: "/d/a.tar" },
    });
    expect(r.status).toBe(400);
  });

  it("answers DELETE_UNSUPPORTED with its reason", async () => {
    server = await startServer();
    await connect(server);
    server.client.reply(/tar -tv/, { stdout: TAR_OUT });
    server.client.reply(/find -H/, { stdout: stat("a.tar") });
    server.client.reply(/mv -f --/, { code: 19 });
    const r = await server.request("POST", `${FS}/fs/archive-delete`, {
      body: { archive: "/d/a.tar", entries: ["/readme.txt"] },
    });
    expect(r.status).toBe(501);
    expect(r.body.code).toBe("DELETE_UNSUPPORTED");
    expect(JSON.stringify(r.body)).toContain("gnu-tar");
  });

  it("declares the op in its @openapi block", async () => {
    const src = await readFile("src/backend/routes.ts", "utf8");
    expect(src).toMatch(/extract-plan, archive-delete, sha256/);
    expect(src).toMatch(/archive-delete: delete entries and folders/);
    expect(src).toMatch(/DELETE_UNSUPPORTED/);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  childrenOf,
  clearArchiveCache,
  dropArchiveCache,
  extractArchiveEntries,
  innerPath,
  listArchive,
  parseTarListing,
  parseZipListing,
  readArchiveEntry,
} from "../../src/backend/archive";
import type { ListTarget } from "../../src/backend/fs-list";
import { FakeClient } from "./fake-ssh";
import { nul, startServer, type TestServer } from "./server";

const TAR_OUT = `drwxr-xr-x root/root         0 2024-03-05 10:20:30 ./
-rw-r--r-- user/staff      120 2024-03-05 10:20:30 ./readme.txt
drwxr-xr-x root/root         0 2024-03-05 10:20:30 ./sub/
-rwxr-xr-x root/root       900 2024-03-06 01:02:03 ./sub/run it.sh
lrwxrwxrwx root/root         0 2024-03-05 10:20:30 ./sub/ln -> ../readme.txt
-rw-r--r-- root/root         7 2024-03-05 10:20:30 deep/er/file.txt
hrwxr-xr-x root/root         0 2024-03-05 10:20:30 hard link to ./readme.txt
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

const target = (client: FakeClient, tools = ["tar", "unzip"]): ListTarget => ({
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

const statReply = (name: string, mtime = "100.0") =>
  nul(name, "f", "999", mtime, "644", "root", "root", "", "f");

afterEach(() => clearArchiveCache());

describe("archive parsing", () => {
  it("parses tar -tv output", () => {
    const e = parseTarListing(TAR_OUT);
    expect(e.map((x) => x.path)).toEqual([
      "/readme.txt",
      "/sub",
      "/sub/run it.sh",
      "/sub/ln",
      "/deep/er/file.txt",
      "/hard",
    ]);
    const link = e.find((x) => x.path === "/sub/ln")!;
    expect(link).toMatchObject({ type: "link", linkTarget: "../readme.txt" });
    const sh = e.find((x) => x.path === "/sub/run it.sh")!;
    expect(sh).toMatchObject({ type: "file", size: 900, mode: 0o755 });
    expect(sh.mtime).toBe(Date.UTC(2024, 2, 6, 1, 2, 3) / 1000);
    expect(e.find((x) => x.path === "/readme.txt")).toMatchObject({
      owner: "user",
      group: "staff",
    });
  });

  it("parses unzip -l output", () => {
    const e = parseZipListing(ZIP_OUT);
    expect(e.map((x) => [x.path, x.type, x.size])).toEqual([
      ["/dir", "directory", 0],
      ["/dir/a b.txt", "file", 12],
      ["/top.txt", "file", 100],
    ]);
  });

  it("builds one folder level with implied folders", () => {
    const e = parseTarListing(TAR_OUT);
    expect(childrenOf(e, "/").map((x) => `${x.name}:${x.type}`)).toEqual([
      "deep:directory",
      "hard:file",
      "readme.txt:file",
      "sub:directory",
    ]);
    expect(childrenOf(e, "/sub").map((x) => x.name)).toEqual([
      "ln",
      "run it.sh",
    ]);
    expect(childrenOf(e, "/deep/er").map((x) => x.name)).toEqual(["file.txt"]);
  });

  it("normalizes inner paths and never lets them climb out", () => {
    expect(innerPath(undefined)).toBe("/");
    expect(innerPath("/a/../../etc")).toBe("/etc");
    expect(innerPath("sub/")).toBe("/sub");
    expect(() => innerPath("a\0b")).toThrow();
  });
});

describe("archive listing and reading", () => {
  it("lists a folder, caches the parse and reports missing folders", async () => {
    const client = new FakeClient([
      [/-maxdepth 0/, { stdout: statReply("a.tgz") }],
      [/tar -tvzf/, { stdout: TAR_OUT }],
    ]);
    const t = target(client);
    const root = await listArchive(t, "/a.tgz", "/");
    expect(root.entries.map((x) => x.name)).toContain("readme.txt");
    expect(root.truncated).toBe(false);
    await listArchive(t, "/a.tgz", "/sub");
    const lists = client.commands.filter((c) => c.includes("tar -tvzf"));
    expect(lists).toHaveLength(1);
    expect(lists[0]).toContain("'/a.tgz'");
    await expect(listArchive(t, "/a.tgz", "/nope")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("re-reads the archive when its mtime changes", async () => {
    const client = new FakeClient([
      [/-maxdepth 0/, { stdout: statReply("a.tar", "1.0") }],
      [/tar -tvf/, { stdout: TAR_OUT }],
    ]);
    const t = target(client);
    await listArchive(t, "/a.tar", "/");
    client.reply(/-maxdepth 0/, { stdout: statReply("a.tar", "2.0") });
    vi.useFakeTimers({ now: Date.now() + 10_000, toFake: ["Date"] });
    try {
      await listArchive(t, "/a.tar", "/");
    } finally {
      vi.useRealTimers();
    }
    expect(client.commands.filter((c) => c.includes("tar -tvf"))).toHaveLength(
      2,
    );
  });

  it("navigates inside an archive without a second scan or stat", async () => {
    const client = new FakeClient([
      [/-maxdepth 0/, { stdout: statReply("a.tgz") }],
      [/tar -tvzf/, { stdout: TAR_OUT }],
    ]);
    const t = target(client);
    await listArchive(t, "/a.tgz", "/");
    await listArchive(t, "/a.tgz", "/sub");
    await readArchiveEntry(t, "/a.tgz", "/readme.txt").catch(() => undefined);
    expect(client.commands.filter((c) => c.includes("tar -tvzf"))).toHaveLength(
      1,
    );
    expect(
      client.commands.filter((c) => c.includes("-maxdepth 0")),
    ).toHaveLength(1);
  });

  it("revalidates by stat later and reuses the scan when unchanged", async () => {
    const client = new FakeClient([
      [/-maxdepth 0/, { stdout: statReply("a.tgz") }],
      [/tar -tvzf/, { stdout: TAR_OUT }],
    ]);
    const t = target(client);
    await listArchive(t, "/a.tgz", "/");
    vi.useFakeTimers({ now: Date.now() + 10_000, toFake: ["Date"] });
    try {
      await listArchive(t, "/a.tgz", "/sub");
    } finally {
      vi.useRealTimers();
    }
    expect(
      client.commands.filter((c) => c.includes("-maxdepth 0")),
    ).toHaveLength(2);
    expect(client.commands.filter((c) => c.includes("tar -tvzf"))).toHaveLength(
      1,
    );
  });

  it("shares one scan between parallel requests and drops it on writes", async () => {
    const client = new FakeClient([
      [/-maxdepth 0/, { stdout: statReply("a.tgz") }],
      [/tar -tvzf/, { stdout: TAR_OUT }],
    ]);
    const t = target(client);
    await Promise.all([
      listArchive(t, "/a.tgz", "/"),
      listArchive(t, "/a.tgz", "/sub"),
    ]);
    expect(client.commands.filter((c) => c.includes("tar -tvzf"))).toHaveLength(
      1,
    );
    dropArchiveCache(t.client);
    await listArchive(t, "/a.tgz", "/");
    expect(client.commands.filter((c) => c.includes("tar -tvzf"))).toHaveLength(
      2,
    );
  });

  it("lists zip archives with unzip and names the missing tool", async () => {
    const client = new FakeClient([
      [/-maxdepth 0/, { stdout: statReply("a.zip") }],
      [/unzip -l/, { stdout: ZIP_OUT }],
    ]);
    const listing = await listArchive(target(client), "/a.zip", "/dir");
    expect(listing.entries.map((x) => x.name)).toEqual(["a b.txt"]);
    await expect(
      listArchive(target(client, ["tar"]), "/a.zip", "/"),
    ).rejects.toMatchObject({ status: 501, code: "NO_TOOL" });
  });

  it("caps the entries it keeps", async () => {
    const many = Array.from(
      { length: 100_005 },
      (_, i) => `-rw-r--r-- r/r 1 2024-01-01 00:00 f${i}`,
    ).join("\n");
    const client = new FakeClient([
      [/-maxdepth 0/, { stdout: statReply("big.tar") }],
      [/tar -tvf/, { stdout: many }],
    ]);
    const listing = await listArchive(target(client), "/big.tar", "/");
    expect(listing.truncated).toBe(true);
    expect(listing.total).toBe(100_005);
    expect(listing.entries).toHaveLength(100_000);
  });

  it("extracts one listed entry by its stored name, as an argument", async () => {
    const client = new FakeClient([
      [/-maxdepth 0/, { stdout: statReply("a.tgz") }],
      [/tar -tvzf/, { stdout: TAR_OUT }],
      [/tar -xOzf/, { stdout: "hello" }],
    ]);
    const { data } = await readArchiveEntry(
      target(client),
      "/a.tgz",
      "/sub/run it.sh",
    );
    expect(data.toString()).toBe("hello");
    expect(client.commands.at(-1)).toContain("'./sub/run it.sh'");
    // Only listed names reach the shell.
    await expect(
      readArchiveEntry(target(client), "/a.tgz", "/etc/passwd"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      readArchiveEntry(target(client), "/a.tgz", "/sub"),
    ).rejects.toMatchObject({ code: "NOT_A_FILE" });
    await expect(
      readArchiveEntry(target(client), "/a.tgz", "/readme.txt", 10),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("escapes unzip patterns in member names", async () => {
    const out = `  Length      Date    Time    Name
---------  ---------- -----   ----
        3  2024-03-05 10:20   we[ir]d*.txt
---------                     -------
`;
    const client = new FakeClient([
      [/-maxdepth 0/, { stdout: statReply("a.zip") }],
      [/unzip -l/, { stdout: out }],
      [/unzip -p/, { stdout: "abc" }],
    ]);
    await readArchiveEntry(target(client), "/a.zip", "/we[ir]d*.txt");
    expect(client.commands.at(-1)).toContain("'we\\[ir\\]d\\*.txt'");
  });
});

describe("archive routes", () => {
  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("serves listings and entries", async () => {
    server = await startServer();
    await server.request("POST", "/ssh/connect", {
      body: { sessionId: "s1", hostId: 7 },
    });
    server.client.reply(/find -H/, { stdout: statReply("a.tgz") });
    server.client.reply(/tar -tvzf/, { stdout: TAR_OUT });
    // the default fake capabilities include tar
    const FS = "/containers/s1/abc123";
    const list = await server.request(
      "GET",
      `${FS}/fs/archive/list?archive=/a.tgz&path=/sub`,
    );
    expect(list.status).toBe(200);
    expect(list.body.entries.map((e: { name: string }) => e.name)).toEqual([
      "ln",
      "run it.sh",
    ]);

    server.client.reply(/tar -xOzf/, { stdout: "echo hi\n" });
    const entry = await server.request(
      "GET",
      `${FS}/fs/archive/entry?archive=/a.tgz&path=/sub/run%20it.sh`,
    );
    expect(entry.status).toBe(200);
    expect(entry.body.content).toBe("echo hi\n");

    const raw = await server.raw(
      "GET",
      `${FS}/fs/archive/entry?archive=/a.tgz&path=/sub/run%20it.sh&download=1`,
    );
    expect(raw.status).toBe(200);
    expect(raw.buffer.toString()).toBe("echo hi\n");
    expect(raw.headers.get("content-disposition")).toContain("run it.sh");

    const bad = await server.request(
      "GET",
      `${FS}/fs/archive/list?archive=/a.txt`,
    );
    expect(bad.status).toBe(400);
  });
});

describe("selective extraction", () => {
  const listed = (archive: string, out: string, listCmd: RegExp) =>
    new FakeClient([
      [/-maxdepth 0/, { stdout: statReply(archive) }],
      [listCmd, { stdout: out }],
    ]);

  it("passes stored member names as positional arguments", async () => {
    const client = listed("a.tgz", TAR_OUT, /tar -tvzf/);
    await extractArchiveEntries(
      target(client),
      "/a.tgz",
      "/out dir",
      ["/sub/run it.sh", "/sub", "/deep"],
      false,
    );
    const cmd = client.commands.at(-1)!;
    // "/sub/run it.sh" is covered by "/sub"; "/deep" is only implied by a child
    expect(cmd).toContain("'/a.tgz' '/out dir' '0' './sub/' 'deep'");
    expect(cmd).toContain('tar -xzf "$a" -C "$t" -- "$@"');
  });

  it("rejects chosen entries that share a basename", async () => {
    const out = `-rw-r--r-- root/root 1 2024-03-05 10:20:30 a/x
-rw-r--r-- root/root 1 2024-03-05 10:20:30 b/x
`;
    const client = listed("d.tar", out, /tar -tvf/);
    await expect(
      extractArchiveEntries(
        target(client),
        "/d.tar",
        "/d",
        ["/a/x", "/b/x"],
        true,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("maps a conflict to EXISTS", async () => {
    const client = listed("a.tgz", TAR_OUT, /tar -tvzf/);
    client.reply(/mktemp/, { code: 17, stderr: "readme.txt" });
    await expect(
      extractArchiveEntries(
        target(client),
        "/a.tgz",
        "/d",
        ["/readme.txt"],
        false,
      ),
    ).rejects.toMatchObject({ status: 409, code: "EXISTS" });
    await extractArchiveEntries(
      target(client),
      "/a.tgz",
      "/d",
      ["/readme.txt"],
      true,
    ).catch(() => {});
    expect(client.commands.at(-1)).toContain(
      "'/a.tgz' '/d' '1' './readme.txt'",
    );
  });

  it("refuses traversal, absolute and unlisted members", async () => {
    const evil = `-rw-r--r-- root/root 1 2024-03-05 10:20:30 ../evil.txt
-rw-r--r-- root/root 1 2024-03-05 10:20:30 /abs.txt
-rw-r--r-- root/root 1 2024-03-05 10:20:30 -opt
`;
    const client = listed("e.tar", evil, /tar -tvf/);
    for (const p of ["/evil.txt", "/abs.txt", "/-opt"]) {
      await expect(
        extractArchiveEntries(target(client), "/e.tar", "/d", [p], true),
      ).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      extractArchiveEntries(
        target(client),
        "/e.tar",
        "/d",
        ["/etc/passwd"],
        true,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      extractArchiveEntries(target(client), "/e.tar", "/d", ["/"], true),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      extractArchiveEntries(target(client), "/e.tar", "/d", [], true),
    ).rejects.toMatchObject({ status: 400 });
    expect(client.commands.some((c) => c.includes("mktemp"))).toBe(false);
  });

  it("uses unzip for zip archives", async () => {
    const client = listed("a.zip", ZIP_OUT, /unzip -l/);
    await extractArchiveEntries(target(client), "/a.zip", "/d", ["/dir"], true);
    const cmd = client.commands.at(-1)!;
    expect(cmd).toContain("'/a.zip' '/d' '1' 'dir/'");
    expect(cmd).toContain('unzip -o -q "$a" -d "$t"');
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  clearArchiveCache,
  extractArchiveEntries,
  kindOf,
  listArchive,
  parseArchiveListing,
  parseSevenZipListing,
  parseUnrarListing,
  readArchiveEntry,
  resolveMembers,
} from "../../src/backend/archive";
import {
  archiveKind,
  extractTools,
  isSingleFile,
  matchesPatterns,
  missingGroup,
  readTools,
  ZIP_EXTENSIONS,
} from "../../src/backend/archive-kinds";
import { appendToArchive } from "../../src/backend/archive-append";
import { extract } from "../../src/backend/fs-ops";
import type { ListTarget } from "../../src/backend/fs-list";
import { archiveKindOf } from "../../src/frontend/archiveKinds";
import { FakeClient } from "./fake-ssh";
import { nul } from "./server";

afterEach(() => clearArchiveCache());

const target = (client: FakeClient, tools: string[]): ListTarget => ({
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

const statReply = (name: string) =>
  nul(name, "f", "999", "100.0", "644", "root", "root", "", "f");

const SEVENZ_OUT = `Path = readme.txt
Folder = -
Size = 120
Packed Size = 100
Modified = 2024-03-05 10:20:30.1234567
Attributes = A -rw-r--r--

Path = sub
Folder = +
Size = 0
Packed Size = 0
Modified = 2024-03-05 10:20:30.0000000
Attributes = D drwxr-xr-x

Path = sub/run it.sh
Folder = -
Size = 900
Modified = 2024-03-06 01:02:03.0000000
Attributes = A -rwxr-xr-x
`;

const UNRAR_OUT = `
Archive: /d/a.rar
Details: RAR 5

        Name: readme.txt
        Type: File
        Size: 120
 Packed size: 100
       Ratio: 83%
       mtime: 2024-03-05 10:20:30,123456789
  Attributes: -rw-r--r--
         CRC32: 00000000

        Name: sub
        Type: Directory
        Size: 0
       mtime: 2024-03-05 10:20:30,000000000
  Attributes: drwxr-xr-x
`;

describe("archive kinds", () => {
  it.each([
    ["a.zip", "zip"],
    ["A.ZIP", "zip"],
    ["app.jar", "zip"],
    ["site.war", "zip"],
    ["app.apk", "zip"],
    ["pkg-1.0-py3-none-any.whl", "zip"],
    ["book.epub", "zip"],
    ["a.tar", "tar"],
    ["a.tar.gz", "tgz"],
    ["a.tgz", "tgz"],
    ["a.tar.bz2", "tbz"],
    ["a.tbz2", "tbz"],
    ["a.tar.xz", "txz"],
    ["a.txz", "txz"],
    ["a.tar.zst", "tzst"],
    ["a.tzst", "tzst"],
    ["a.7z", "7z"],
    ["A.7Z", "7z"],
    ["a.rar", "rar"],
    ["notes.txt.gz", "gz"],
    ["notes.txt.bz2", "bz2"],
    ["notes.txt.xz", "xz"],
    ["notes.txt.zst", "zst"],
    ["a.txt", null],
    ["a.tar.Z", null],
    ["archive", null],
    ["zip", null],
  ])("reads %s as %s", (name, kind) => {
    expect(archiveKind(name)).toBe(kind);
  });

  it("agrees with the frontend on every name", () => {
    const names = [
      ...ZIP_EXTENSIONS.map((e) => `x.${e}`),
      "x.TAR.GZ",
      "x.tbz",
      "x.tzst",
      "x.tar.zst",
      "x.7z",
      "x.rar",
      "x.gz",
      "x.xz",
      "x.zst",
      "x.bz2",
      "x.txt",
      "x.tar.Z",
      "x",
      ".gz",
    ];
    for (const n of names) expect(archiveKindOf(n)).toBe(archiveKind(n));
  });

  it("tells single compressed files from archives", () => {
    for (const k of ["gz", "bz2", "xz", "zst"] as const)
      expect(isSingleFile(k)).toBe(true);
    for (const k of ["zip", "tar", "tgz", "tzst", "7z", "rar"] as const)
      expect(isSingleFile(k)).toBe(false);
    expect(matchesPatterns("7z")).toBe(true);
    expect(matchesPatterns("rar")).toBe(true);
    expect(matchesPatterns("zip")).toBe(false);
  });

  it("names the tools each kind needs", () => {
    expect(missingGroup(["tar"], readTools("tzst"))?.label).toBe("zstd");
    expect(missingGroup(["tar", "zstd"], readTools("tzst"))).toBeUndefined();
    expect(missingGroup(["7za"], readTools("7z"))).toBeUndefined();
    // 7zr and 7za cannot read rar; unrar or a full 7z can.
    expect(missingGroup(["7za", "7zr"], readTools("rar"))?.label).toBe("unrar");
    expect(missingGroup(["unrar"], readTools("rar"))).toBeUndefined();
    // bsdtar stands in for the whole-archive extract only.
    expect(missingGroup(["bsdtar"], readTools("7z"))?.label).toBe("7z");
    expect(missingGroup(["bsdtar"], extractTools("7z"))).toBeUndefined();
    expect(missingGroup(["bsdtar"], extractTools("rar"))).toBeUndefined();
    expect(missingGroup([], extractTools("gz"))?.label).toBe("gzip");
  });

  it("keeps single files out of browsing", () => {
    expect(() => kindOf("/d/a.txt.gz")).toThrow(
      expect.objectContaining({ code: "NOT_BROWSABLE" }),
    );
    expect(() => kindOf("/d/a.txt")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(kindOf("/d/a.7z")).toBe("7z");
  });
});

describe("7z and rar listing parsers", () => {
  it("parses 7z -slt output", () => {
    const e = parseSevenZipListing(SEVENZ_OUT);
    expect(e.map((x) => [x.path, x.type, x.size])).toEqual([
      ["/readme.txt", "file", 120],
      ["/sub", "directory", 0],
      ["/sub/run it.sh", "file", 900],
    ]);
    expect(e[2]).toMatchObject({ mode: 0o755, raw: "sub/run it.sh" });
    expect(e[0].mtime).toBe(Date.UTC(2024, 2, 5, 10, 20, 30) / 1000);
  });

  it("parses unrar lt output", () => {
    const e = parseUnrarListing(UNRAR_OUT);
    expect(e.map((x) => [x.path, x.type, x.size])).toEqual([
      ["/readme.txt", "file", 120],
      ["/sub", "directory", 0],
    ]);
  });

  it("picks the parser for rar by what the tool printed", () => {
    expect(parseArchiveListing("rar", SEVENZ_OUT)).toHaveLength(3);
    expect(parseArchiveListing("rar", UNRAR_OUT)).toHaveLength(2);
    expect(parseArchiveListing("7z", SEVENZ_OUT)).toHaveLength(3);
    expect(parseArchiveListing("7z", "")).toEqual([]);
  });
});

describe("listing and reading commands", () => {
  it.each([
    ["/d/a.7z", "7z", SEVENZ_OUT],
    ["/d/a.rar", "unrar", UNRAR_OUT],
  ])(
    "lists %s with the archive as a positional argument",
    async (path, tool, out) => {
      const client = new FakeClient([
        [/-maxdepth 0/, { stdout: statReply("a") }],
        [/-slt -ba|unrar lt/, { stdout: out }],
      ]);
      const tools = tool === "7z" ? ["7zz"] : ["unrar"];
      const l = await listArchive(target(client, tools), path, "/");
      expect(l.entries.map((x) => x.name)).toEqual(["readme.txt", "sub"]);
      const cmd = client.commands.find((c) => c.includes("-slt"))!;
      expect(cmd).toContain(`'${path}'`);
      expect(cmd).toContain("</dev/null");
    },
  );

  it("lists a tar.zst through zstd and tar", async () => {
    const client = new FakeClient([
      [/-maxdepth 0/, { stdout: statReply("a") }],
      [
        /zstd -dc/,
        { stdout: "-rw-r--r-- u/g 5 2024-03-05 10:20:30 ./x.txt\n" },
      ],
    ]);
    const l = await listArchive(
      target(client, ["tar", "zstd"]),
      "/d/a.tar.zst",
      "/",
    );
    expect(l.entries.map((x) => x.name)).toEqual(["x.txt"]);
    expect(client.commands.some((c) => c.includes("'/d/a.tar.zst'"))).toBe(
      true,
    );
  });

  it("lists a jar as a zip", async () => {
    const client = new FakeClient([
      [/-maxdepth 0/, { stdout: statReply("a") }],
      [
        /unzip -l/,
        {
          stdout:
            "  Length      Date    Time    Name\n---------  ---------- -----   ----\n       10  2024-03-05 10:20   META-INF/m.txt\n---------                     -------\n",
        },
      ],
    ]);
    const l = await listArchive(target(client, ["unzip"]), "/d/a.jar", "/");
    expect(l.entries.map((x) => x.name)).toEqual(["META-INF"]);
  });

  it("explains a missing tool before running anything", async () => {
    const cases: Array<[string, string[], string]> = [
      ["/d/a.7z", ["tar"], "7z"],
      ["/d/a.rar", ["7za"], "unrar"],
      ["/d/a.tzst", ["tar"], "zstd"],
      ["/d/a.zip", ["tar"], "unzip"],
    ];
    for (const [path, tools, tool] of cases) {
      const client = new FakeClient();
      const error = await listArchive(target(client, tools), path, "/").catch(
        (e) => e,
      );
      expect(error).toMatchObject({ status: 501, code: "NO_TOOL" });
      expect(error.details).toEqual({ tool });
      expect(error.message).toContain(`${tool} is not installed`);
      expect(client.commands).toHaveLength(0);
    }
  });

  it("refuses to browse a single compressed file", async () => {
    const client = new FakeClient();
    await expect(
      listArchive(target(client, ["gzip"]), "/d/a.txt.gz", "/"),
    ).rejects.toMatchObject({ code: "NOT_BROWSABLE" });
    expect(client.commands).toHaveLength(0);
  });

  it("reads an entry of a 7z with -so and a literal name", async () => {
    const client = new FakeClient([
      [/-maxdepth 0/, { stdout: statReply("a") }],
      [/-slt -ba/, { stdout: SEVENZ_OUT }],
      [/e -so/, { stdout: "hello" }],
    ]);
    const r = await readArchiveEntry(
      target(client, ["7z"]),
      "/d/a.7z",
      "/sub/run it.sh",
    );
    expect(r.data.toString()).toBe("hello");
    const cmd = client.commands.find((c) => c.includes("e -so"))!;
    expect(cmd).toContain("'/d/a.7z' 'sub/run it.sh'");
  });

  it("refuses 7z member names that the tool would read as patterns", () => {
    const entries = parseSevenZipListing(
      "Path = a*b\nFolder = -\nSize = 1\nAttributes = A -rw-r--r--\n\nPath = @list\nFolder = -\nSize = 1\nAttributes = A -rw-r--r--\n",
    );
    expect(() => resolveMembers(entries, ["/a*b"], "7z")).toThrow(
      /Unsupported entry name/,
    );
    expect(() => resolveMembers(entries, ["/@list"], "7z")).toThrow(
      /Unsupported entry name/,
    );
    // zip and tar take these names literally.
    expect(resolveMembers(entries, ["/a*b"], "tar")).toEqual(["a*b"]);
  });

  it("extracts chosen entries from a rar through the same script", async () => {
    const client = new FakeClient([
      [/-maxdepth 0/, { stdout: statReply("a") }],
      [/-slt -ba|unrar lt/, { stdout: UNRAR_OUT }],
    ]);
    await extractArchiveEntries(
      target(client, ["unrar"]),
      "/d/a.rar",
      "/out",
      ["/readme.txt"],
      false,
    );
    const cmd = client.commands.at(-1)!;
    expect(cmd).toContain("'/d/a.rar' '/out' '0' 'readme.txt'");
  });
});

describe("whole-archive extract", () => {
  const ran = (c: FakeClient) => c.commands.at(-1)!;

  it.each([
    ["/d/a.7z", ["7zz"]],
    ["/d/a.rar", ["unrar"]],
    ["/d/a.tzst", ["tar", "zstd"]],
    ["/d/a.tar.zst", ["tar", "zstd"]],
    ["/d/a.jar", ["unzip"]],
    ["/d/a.txt.gz", ["gzip"]],
    ["/d/a.txt.bz2", ["bzip2"]],
    ["/d/a.txt.xz", ["xz"]],
    ["/d/a.txt.zst", ["zstd"]],
  ])("passes %s as a positional argument", async (path, tools) => {
    const client = new FakeClient();
    await extract(target(client, tools), path, "/out dir", true);
    expect(ran(client)).toContain(`'${path}' '/out dir' '1'`);
  });

  it("uses bsdtar when it is the only reader", async () => {
    const client = new FakeClient();
    await extract(target(client, ["bsdtar"]), "/d/a.7z", "/out");
    expect(ran(client)).toContain("bsdtar -xf");
  });

  it.each([
    ["/d/a.7z", [], "7z"],
    ["/d/a.rar", ["7za"], "unrar"],
    ["/d/a.tzst", ["tar"], "zstd"],
    ["/d/a.txt.gz", ["tar"], "gzip"],
    ["/d/a.txt.xz", [], "xz"],
  ])("names the missing tool for %s", async (path, tools, tool) => {
    const client = new FakeClient();
    const error = await extract(target(client, tools), path, "/out").catch(
      (e) => e,
    );
    expect(error).toMatchObject({ status: 501, code: "NO_TOOL" });
    expect(error.message).toBe(`${tool} is not installed in this container`);
    expect(client.commands).toHaveLength(0);
  });

  it("decompresses a single file into a temp file and moves it", async () => {
    const client = new FakeClient();
    await extract(target(client, ["gzip"]), "/d/log.txt.gz", "/out");
    const cmd = ran(client);
    expect(cmd).toContain('mktemp "$2/.extract.XXXXXX"');
    expect(cmd.indexOf("gzip -dc")).toBeLessThan(cmd.lastIndexOf("mv -f --"));
  });
});

describe("append to 7z and tar.zst", () => {
  const mv = (c: FakeClient) => c.commands.find((x) => x.includes("mv -f --"))!;

  it("adds to a 7z with the installed 7-Zip build", async () => {
    const client = new FakeClient();
    await appendToArchive(target(client, ["7za"]), "/d/a.7z", "/src", [
      "x y",
      "it's",
    ]);
    const cmd = mv(client);
    expect(cmd).toContain("'/d/a.7z' '7z'");
    expect(cmd).toContain("'7za' 'x y' 'it'\\''s'");
    expect(cmd).toContain('"$c" a -y -- "$w"');
    expect(cmd.indexOf('"$c" a -y')).toBeLessThan(cmd.indexOf("mv -f --"));
    expect(cmd).toContain('cp -p -- "$a" "$w"');
  });

  it("prefers 7zz over the others", async () => {
    const client = new FakeClient();
    await appendToArchive(
      target(client, ["7zr", "7z", "7zz"]),
      "/d/a.7z",
      "/src",
      ["x"],
    );
    expect(mv(client)).toContain("'7zz' 'x'");
  });

  it("rewrites a tar.zst through a temporary tar", async () => {
    const client = new FakeClient();
    await appendToArchive(
      target(client, ["tar", "zstd"]),
      "/d/a.tzst",
      "/src",
      ["x"],
    );
    const cmd = mv(client);
    expect(cmd).toContain("'/d/a.tzst' 'tzst'");
    expect(cmd).toContain("'zstd' 'x'");
    expect(cmd).toMatch(/\.cf-part-[0-9a-f]{8}-a\.tzst\.tar'/);
  });

  it("refuses names a 7z would read as patterns", async () => {
    const client = new FakeClient();
    for (const n of ["a*", "b?", "@list"]) {
      await expect(
        appendToArchive(target(client, ["7z"]), "/d/a.7z", "/src", [n]),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_NAME" });
    }
    expect(client.commands).toHaveLength(0);
  });

  it.each([
    ["/d/a.7z", ["tar"], "7z"],
    ["/d/a.tzst", ["tar"], "zstd"],
  ])("names the missing tool for %s", async (path, tools, tool) => {
    const client = new FakeClient([[/mv -f --/, { code: 20 }]]);
    const error = await appendToArchive(target(client, tools), path, "/src", [
      "x",
    ]).catch((e) => e);
    expect(error).toMatchObject({ status: 501 });
    expect(error.message).toContain(tool);
  });

  it("explains that rar and single files cannot be changed", async () => {
    const client = new FakeClient();
    const rar = await appendToArchive(
      target(client, ["unrar"]),
      "/d/a.rar",
      "/src",
      ["x"],
    ).catch((e) => e);
    expect(rar).toMatchObject({ status: 501, code: "APPEND_UNSUPPORTED" });
    expect(rar.details).toEqual({ reason: "rar" });
    const gz = await appendToArchive(
      target(client, ["gzip"]),
      "/d/a.txt.gz",
      "/src",
      ["x"],
    ).catch((e) => e);
    expect(gz.details).toEqual({ reason: "single-file" });
    expect(client.commands).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import tar from "tar-stream";
import {
  applyLinkInfo,
  listDirectory,
  parseFindOutput,
  parseStatOutput,
  pathVariants,
  type ListTarget,
} from "../../src/backend/fs-list";
import { parseProbe } from "../../src/backend/capabilities";
import { parseInspect, parseContainerList } from "../../src/backend/containers";
import { parseRuntime } from "../../src/backend/runtime";
import { FakeClient } from "./fake-ssh";

const nul = (...f: string[]) => f.join("\0") + "\0";

describe("parseFindOutput", () => {
  it("parses files, dirs and links with odd names", () => {
    const out =
      nul(
        "a b.txt",
        "f",
        "12",
        "1700000000.123",
        "644",
        "root",
        "root",
        "",
        "f",
      ) +
      nul(
        "dir\nnew",
        "d",
        "4096",
        "1700000001.0",
        "755",
        "app",
        "app",
        "",
        "d",
      ) +
      nul("ln", "l", "3", "1700000002.5", "777", "root", "root", "/etc", "d") +
      nul(
        "dangling",
        "l",
        "3",
        "1700000002.5",
        "777",
        "root",
        "root",
        "/nope",
        "N",
      );
    const entries = parseFindOutput(out);
    expect(entries.map((e) => e.name)).toEqual([
      "a b.txt",
      "dir\nnew",
      "ln",
      "dangling",
    ]);
    expect(entries[0]).toMatchObject({
      type: "file",
      size: 12,
      mtime: 1700000000,
      mode: 0o644,
    });
    expect(entries[1].type).toBe("directory");
    expect(entries[2]).toMatchObject({
      type: "link",
      linkTarget: "/etc",
      linkKind: "directory",
    });
    expect(entries[3].linkKind).toBe("missing");
  });

  it("returns nothing for empty output", () => {
    expect(parseFindOutput("")).toEqual([]);
  });
});

describe("parseStatOutput", () => {
  it("parses BusyBox lines and strips the directory prefix", () => {
    const out = [
      "regular file|5|1700000000|644|root|root|/etc/a|b",
      "directory|4096|1700000001|755|root|root|/etc/sub",
      "symbolic link|4|1700000002|777|root|root|/etc/lnk",
      "regular empty file|0|1700000003|600|root|root|/etc/two",
    ].join(String.fromCharCode(10));
    const entries = parseStatOutput(out, "/etc");
    expect(entries.map((e) => e.name)).toEqual(["a|b", "sub", "lnk", "two"]);
    expect(entries[2].type).toBe("link");
    expect(entries[3].type).toBe("file");
  });

  it("joins names that contain newlines", () => {
    const out = "regular file|1|1|644|r|r|/d/first\nsecond";
    expect(parseStatOutput(out, "/d")[0].name).toBe("first\nsecond");
  });

  it("handles the root directory", () => {
    const out = "directory|1|1|755|r|r|/etc";
    expect(parseStatOutput(out, "/")[0].name).toBe("etc");
  });

  it("applies link info", () => {
    const entries = parseStatOutput(
      "symbolic link|4|1|777|r|r|/d/l1\nsymbolic link|4|1|777|r|r|/d/l2",
      "/d",
    );
    applyLinkInfo(
      entries,
      nul("/d/l1", "d", "/x") + nul("/d/l2", "m", "/y"),
      "/d",
    );
    expect(entries[0]).toMatchObject({
      linkKind: "directory",
      linkTarget: "/x",
    });
    expect(entries[1].linkKind).toBe("missing");
  });
});

describe("misc parsers", () => {
  it("parses the capability probe", () => {
    const caps = parseProbe("tool:find\ntool:tar\nfindPrintf\nprobed\n", true);
    expect(caps).toMatchObject({ exec: true, findPrintf: true, statC: false });
    expect(caps.tools).toEqual(["find", "tar"]);
    expect(parseProbe("", false).exec).toBe(false);
    expect(parseProbe("tool:find\n", true).exec).toBe(false);
  });

  it("parses inspect and ps output", () => {
    expect(parseInspect("abc|true|/web\n")).toEqual({
      id: "abc",
      running: true,
      status: "running",
      name: "web",
    });
    expect(parseInspect("abc|true|paused|/web\n")).toEqual({
      id: "abc",
      running: false,
      status: "paused",
      name: "web",
    });
    expect(parseInspect("abc|false|exited|/web\n")).toMatchObject({
      running: false,
      status: "exited",
    });
    expect(parseInspect("garbage")).toBeNull();
    expect(parseContainerList('{"id":"1"}\nnot json\n')).toHaveLength(1);
  });

  it("detects runtime", () => {
    expect(parseRuntime("/usr/local/bin/podman\n")).toBe("podman");
    expect(parseRuntime("/usr/bin/docker\n/usr/bin/podman\n")).toBe("docker");
    expect(parseRuntime("")).toBeNull();
  });
});

describe("listDirectory", () => {
  const caps = {
    running: true,
    exec: true,
    findPrintf: true,
    statC: true,
    tools: [],
  };
  const make = (client: FakeClient, capabilities = caps): ListTarget => ({
    client: client.asClient(),
    runtime: "docker",
    containerId: "abc",
    capabilities,
  });

  it("uses find when available, with the path as a positional argument", async () => {
    const client = new FakeClient([
      [
        /find -H/,
        { stdout: nul("x", "f", "1", "1.0", "644", "r", "r", "", "f") },
      ],
    ]);
    const res = await listDirectory(make(client), "/it's");
    expect(res.tier).toBe("find");
    expect(res.entries[0].name).toBe("x");
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toContain(`'/it'\\''s'`);
  });

  it("maps missing directories to 404", async () => {
    const client = new FakeClient([
      [
        /find -H/,
        { code: 1, stderr: "find: '/nope': No such file or directory" },
      ],
    ]);
    await expect(listDirectory(make(client), "/nope")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("maps the directory pre-check exit codes", async () => {
    for (const [code, status] of [
      [44, 404],
      [45, 400],
      [46, 403],
    ] as const) {
      const client = new FakeClient([[/find -H/, { code }]]);
      await expect(listDirectory(make(client), "/x")).rejects.toMatchObject({
        status,
      });
    }
  });

  it("keeps the listing when find reports vanished entries", async () => {
    const client = new FakeClient([
      [
        /find -H/,
        {
          code: 0,
          stdout: nul("a", "f", "1", "1", "644", "r", "r", "", "f"),
        },
      ],
    ]);
    const res = await listDirectory(make(client), "/proc");
    expect(res.entries.map((e) => e.name)).toEqual(["a"]);
    expect(client.commands[0]).toContain("2>/dev/null; exit 0");
  });

  it("falls back to stat, then fetches link info once", async () => {
    const client = new FakeClient([
      [/-type l/, { stdout: nul("/d/l", "d", "/x") }],
      [
        /stat -c/,
        {
          stdout:
            "symbolic link|1|1|777|r|r|/d/l\nregular file|1|1|644|r|r|/d/f\n",
        },
      ],
    ]);
    const res = await listDirectory(
      make(client, { ...caps, findPrintf: false }),
      "/d",
    );
    expect(res.tier).toBe("stat");
    expect(res.entries[0].linkKind).toBe("directory");
    expect(client.commands).toHaveLength(2);
  });

  it("reads direct children from cp headers when there is no shell", async () => {
    const pack = tar.pack();
    pack.entry({ name: "d/", type: "directory" });
    pack.entry({ name: "d/a.txt", size: 3 }, "abc");
    pack.entry({ name: "d/sub/", type: "directory" });
    pack.entry({ name: "d/sub/deep.txt", size: 1 }, "x");
    pack.entry({ name: "d/l", type: "symlink", linkname: "a.txt" });
    pack.finalize();
    const chunks: Buffer[] = [];
    for await (const c of pack) chunks.push(c as Buffer);

    const client = new FakeClient([
      [/'cp'/, { stdout: Buffer.concat(chunks) }],
    ]);
    const res = await listDirectory(
      make(client, { ...caps, exec: false, running: false }),
      "/d",
    );
    expect(res.tier).toBe("cp");
    expect(res.entries.map((e) => e.name).sort()).toEqual([
      "a.txt",
      "l",
      "sub",
    ]);
    expect(res.entries.find((e) => e.name === "l")).toMatchObject({
      type: "link",
      linkTarget: "a.txt",
    });
    expect(res.truncated).toBe(false);
  });
});

describe("listDirectory diagnostics and cd fallback", () => {
  const caps = {
    running: true,
    exec: true,
    findPrintf: true,
    statC: true,
    tools: [],
  };
  const make = (client: FakeClient, capabilities = caps): ListTarget => ({
    client: client.asClient(),
    runtime: "docker",
    containerId: "abc",
    capabilities,
  });
  const PRIMARY = /\[ ! -e/;
  const FALLBACK = /cd -- /;
  const DIAG = /od -An/;

  it("lists through cd when the pre-check wrongly says the path is missing", async () => {
    const client = new FakeClient([
      [PRIMARY, { code: 44, stderr: "ls: /shares/docs/books\n" }],
      [
        FALLBACK,
        { stdout: nul("Книги", "d", "1", "1.0", "755", "r", "r", "", "d") },
      ],
    ]);
    const res = await listDirectory(make(client), "/shares/docs/books");
    expect(res.entries.map((e) => e.name)).toEqual(["Книги"]);
    expect(res.path).toBe("/shares/docs/books");
    expect(client.commands).toHaveLength(2);
    expect(client.commands[1]).toContain("'/shares/docs/books'");
  });

  it("never strips ordinary letters from a path", () => {
    expect(pathVariants("/shares/docs")).toEqual(["/shares/docs"]);
  });

  it("retries lookalike paths (trailing NBSP, zero-width, NFD)", async () => {
    const typed = "/shares/docs/Книги ​";
    const client = new FakeClient([
      [PRIMARY, { code: 44 }],
      [
        FALLBACK,
        (stream) => {
          const cmd = client.commands.at(-1)!;
          if (cmd.includes("'/shares/docs/Книги'")) {
            stream.finish(nul("a", "f", "1", "1", "644", "r", "r", "", "f"));
          } else stream.finish("", 44);
        },
      ],
    ]);
    const res = await listDirectory(make(client), typed);
    expect(res.path).toBe("/shares/docs/Книги");
    expect(res.entries[0].name).toBe("a");
  });

  it("reports stderr, exit code and the path bytes when everything fails", async () => {
    const dir = "/shares/docs/Книги ";
    const client = new FakeClient([
      [
        PRIMARY,
        {
          code: 44,
          stderr: "ls: /shares/docs/Книги : No such file or directory\n",
        },
      ],
      [FALLBACK, { code: 44 }],
      [
        DIAG,
        {
          stdout:
            "uid=0\ncwd=/\nhex=2f 73\nls=ls: x: No such file or directory \nparent=drwxr-xr-x 2 root root /shares/docs/\n",
        },
      ],
    ]);
    const err = await listDirectory(make(client), dir).catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.message).toContain("No such file or directory");
    expect(err.message).toContain("exit 44");
    expect(err.message).toContain("uid 0");
    expect(err.message).toContain("cwd /");
    expect(err.message).toContain("received 2f 73");
    expect(err.details).toMatchObject({
      exitCode: 44,
      uid: "0",
      cwd: "/",
      sentHex: Buffer.from(dir)
        .toString("hex")
        .replace(/(..)(?=.)/g, "$1 "),
    });
    // trailing space is visible in the sent bytes (20 at the end)
    expect(err.details.sentHex.endsWith(" 20")).toBe(true);
  });

  it("falls back for the stat tier and strips the ./ prefix", async () => {
    const client = new FakeClient([
      [PRIMARY, { code: 44 }],
      [FALLBACK, { stdout: "regular file|1|1|644|r|r|./f\n" }],
    ]);
    const res = await listDirectory(
      make(client, { ...caps, findPrintf: false }),
      "/d",
    );
    expect(res.entries.map((e) => e.name)).toEqual(["f"]);
  });

  it("still maps permission errors to 403 with diagnostics", async () => {
    const client = new FakeClient([
      [PRIMARY, { code: 46, stderr: "ls: /x: Permission denied\n" }],
      [FALLBACK, { code: 44 }],
    ]);
    const err = await listDirectory(make(client), "/x").catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.message).toContain("exit 46");
  });
});

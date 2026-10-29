import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLACE_SCRIPT,
  extractPlanItems,
  extractWithPolicy,
  parseExtractPolicy,
  placeArguments,
  placeError,
  stageDirectory,
} from "../../src/backend/extract-policy";
import { clearArchiveCache } from "../../src/backend/archive";
import type { ListTarget } from "../../src/backend/fs-list";
import { FakeClient } from "./fake-ssh";
import { nul, startServer, type TestServer } from "./server";

const TAR_OUT = `drwxr-xr-x root/root 0 2024-03-05 10:20:30 ./
-rw-r--r-- root/root 12 2024-03-05 10:20:30 ./readme.txt
drwxr-xr-x root/root 0 2024-03-05 10:20:30 ./sub/
-rw-r--r-- root/root 9 2024-03-05 10:20:30 ./sub/run it.sh
-rw-r--r-- root/root 7 2024-03-05 10:20:30 other/deep.txt
`;

const target = (client: FakeClient): ListTarget => ({
  client: client.asClient(),
  runtime: "docker",
  containerId: "abc",
  capabilities: {
    running: true,
    exec: true,
    findPrintf: true,
    statC: true,
    tools: ["tar", "unzip"],
  },
});

const statReply = (name: string) =>
  nul(name, "f", "999", "100.0", "644", "root", "root", "", "f");

afterEach(() => clearArchiveCache());

describe("parseExtractPolicy", () => {
  it("is null without choices, or with empty ones", () => {
    expect(parseExtractPolicy({})).toBeNull();
    expect(parseExtractPolicy({ skip: [], renames: {} })).toBeNull();
  });

  it("reads skip and renames", () => {
    expect(
      parseExtractPolicy({
        skip: ["a", "a", "b c"],
        renames: { x: "x (2)", "y z": "y z (2)" },
      }),
    ).toEqual({
      skip: ["a", "b c"],
      renames: { x: "x (2)", "y z": "y z (2)" },
      replace: [],
    });
  });

  it.each([
    { skip: "a" },
    { skip: [1] },
    { skip: [""] },
    { skip: [".."] },
    { skip: ["."] },
    { skip: ["a/b"] },
    { skip: ["a\nb"] },
    { skip: ["a\0b"] },
    { renames: [] },
    { renames: null },
    { renames: { a: "" } },
    { renames: { a: "../b" } },
    { renames: { "a/b": "c" } },
    { renames: { a: "x", b: "x" } },
    { renames: { a: "b", b: "c" } },
    { renames: { a: "a" } },
    { skip: ["q"], replace: "a" },
    { skip: ["q"], replace: ["a/b"] },
  ])("rejects %j", (body) => {
    expect(() => parseExtractPolicy(body)).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("limits the number of names", () => {
    const skip = Array.from({ length: 1001 }, (_, i) => `n${i}`);
    expect(() => parseExtractPolicy({ skip })).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });
});

describe("placement command", () => {
  it("passes every name as a positional argument", () => {
    const args = placeArguments(
      "/d/.cf-extract-1",
      "/d",
      parseExtractPolicy({
        skip: ["it's $(x)"],
        renames: { "a b": "a b (2)" },
      })!,
    );
    expect(args).toEqual([
      "/d/.cf-extract-1",
      "/d",
      "1",
      "it's $(x)",
      "0",
      "a b",
      "a b (2)",
    ]);
  });

  it("keeps names out of the script text", () => {
    expect(PLACE_SCRIPT).not.toMatch(/readme|\.txt/);
    expect(stageDirectory("/data/x y")).toMatch(
      /^\/data\/x y\/\.cf-extract-[0-9a-f]{12}$/,
    );
  });

  it("stages in the destination, places, and always cleans up", async () => {
    const client = new FakeClient();
    const seen: string[] = [];
    await extractWithPolicy(
      target(client),
      "/out dir",
      { skip: ["a"], renames: { b: "b (2)" }, replace: ["r"] },
      async (stage) => {
        seen.push(stage);
      },
    );
    expect(seen[0]).toMatch(/^\/out dir\/\.cf-extract-[0-9a-f]{12}$/);
    const place = client.commands[0]!;
    expect(place).toContain(
      `'${seen[0]}' '/out dir' '1' 'a' '1' 'r' 'b' 'b (2)'`,
    );
    expect(client.commands.at(-1)).toContain(`rm -rf -- "$1"`);
    expect(client.commands.at(-1)).toContain(`'${seen[0]}'`);
  });

  it("cleans up when the extraction fails and does not place", async () => {
    const client = new FakeClient();
    await expect(
      extractWithPolicy(
        target(client),
        "/d",
        { skip: [], renames: { a: "b" }, replace: [] },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toContain(`rm -rf -- "$1"`);
  });

  it("maps a taken new name to EXISTS", async () => {
    const client = new FakeClient([[/ns=\$3/, { code: 17, stderr: "b (2)" }]]);
    await expect(
      extractWithPolicy(
        target(client),
        "/d",
        { skip: [], renames: { a: "b (2)" }, replace: [] },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ status: 409, code: "EXISTS" });
    expect(client.commands.at(-1)).toContain(`rm -rf -- "$1"`);
  });
});

describe("the placement script on a real shell", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  let hasSh = true;
  try {
    execFileSync("sh", ["-c", "exit 0"]);
  } catch {
    hasSh = false;
  }
  const sh = (p: string) => p.replace(/\\/g, "/");

  function place(
    stageFiles: Record<string, string>,
    destFiles: Record<string, string>,
    policy: Parameters<typeof placeArguments>[2],
  ) {
    const dest = mkdtempSync(join(tmpdir(), "cf-place-"));
    dirs.push(dest);
    const stage = join(dest, ".cf-extract-test");
    for (const [rel, body] of Object.entries(stageFiles)) {
      mkdirSync(join(stage, rel, ".."), { recursive: true });
      writeFileSync(join(stage, rel), body);
    }
    for (const [rel, body] of Object.entries(destFiles)) {
      mkdirSync(join(dest, rel, ".."), { recursive: true });
      writeFileSync(join(dest, rel), body);
    }
    let code = 0;
    try {
      execFileSync(
        "sh",
        [
          "-c",
          PLACE_SCRIPT,
          "sh",
          ...placeArguments(sh(stage), sh(dest), policy),
        ],
        { stdio: "pipe" },
      );
    } catch (error) {
      code = (error as { status: number }).status;
    }
    const read = (rel: string) =>
      existsSync(join(dest, rel))
        ? readFileSync(join(dest, rel), "utf8")
        : null;
    return { dest, stage, code, read };
  }

  it.runIf(hasSh)(
    "replaces, skips, renames and merges folders, then removes the stage",
    () => {
      const r = place(
        {
          "new.txt": "N",
          "skipped.txt": "S",
          "clash.txt": "C",
          "has space.txt": "H",
          "dir/inner.txt": "I",
          ".hidden": "X",
        },
        {
          "new.txt": "old",
          "skipped.txt": "keep me",
          "clash.txt": "mine",
          "dir/mine.txt": "M",
        },
        {
          skip: ["skipped.txt"],
          renames: { "clash.txt": "clash (2).txt" },
          replace: ["new.txt", "dir"],
        },
      );
      expect(r.code).toBe(0);
      expect(r.read("new.txt")).toBe("N");
      expect(r.read("skipped.txt")).toBe("keep me");
      expect(r.read("clash.txt")).toBe("mine");
      expect(r.read("clash (2).txt")).toBe("C");
      expect(r.read("has space.txt")).toBe("H");
      expect(r.read("dir/inner.txt")).toBe("I");
      expect(r.read("dir/mine.txt")).toBe("M");
      expect(r.read(".hidden")).toBe("X");
      expect(existsSync(r.stage)).toBe(false);
      expect(readdirSync(r.dest).sort()).not.toContain(".cf-extract-test");
    },
  );

  it.runIf(hasSh)("refuses a rename onto an existing name (17)", () => {
    const r = place(
      { "a.txt": "A" },
      { "a (2).txt": "taken" },
      { skip: [], renames: { "a.txt": "a (2).txt" }, replace: [] },
    );
    expect(r.code).toBe(17);
    expect(r.read("a (2).txt")).toBe("taken");
    expect(existsSync(r.stage)).toBe(false);
  });

  it.runIf(hasSh)(
    "never overwrites an existing name that is not listed to replace (18)",
    () => {
      const r = place(
        { "a.txt": "A", "b.txt": "B", "dir/x.txt": "X" },
        { "b.txt": "mine", "dir/y.txt": "Y" },
        { skip: [], renames: {}, replace: ["dir"] },
      );
      expect(r.code).toBe(18);
      // Checked before the first move: nothing at all was placed.
      expect(r.read("b.txt")).toBe("mine");
      expect(r.read("a.txt")).toBeNull();
      expect(r.read("dir/x.txt")).toBeNull();
      expect(existsSync(r.stage)).toBe(false);
    },
  );

  it.runIf(hasSh)("refuses a rename onto a staged name (19)", () => {
    const r = place(
      { "a.txt": "A", "b.txt": "B" },
      {},
      { skip: [], renames: { "a.txt": "b.txt" }, replace: [] },
    );
    expect(r.code).toBe(19);
    expect(r.read("a.txt")).toBeNull();
    expect(existsSync(r.stage)).toBe(false);
  });

  it("describes a partial placement", () => {
    const err = placeError({
      code: 20,
      stdout: "",
      stderr: "cp: boom\ncf-placed: a\ncf-placed: b\ncf-failed: c\n",
    } as never);
    expect(err).toMatchObject({
      status: 500,
      code: "EXTRACT_PARTIAL",
      details: { placed: ["a", "b"], failed: "c" },
    });
    expect(err.message).toContain("already placed: a, b");
    expect(err.message).toContain("boom");
    expect(
      placeError({ code: 18, stdout: "", stderr: "x" } as never),
    ).toMatchObject({
      status: 409,
      code: "EXISTS",
    });
    expect(
      placeError({ code: 19, stdout: "", stderr: "x" } as never),
    ).toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
    });
  });

  it.runIf(hasSh)("treats shell-looking names as plain text", () => {
    const name = "$(touch pwned) `x`; 'q'.txt";
    const r = place(
      { [name]: "Z", "ok.txt": "O" },
      {},
      { skip: [], renames: { [name]: "safe.txt" }, replace: [] },
    );
    expect(r.code).toBe(0);
    expect(r.read("safe.txt")).toBe("Z");
    expect(r.read("pwned")).toBeNull();
  });
});

describe("extractPlanItems", () => {
  const client = () =>
    new FakeClient([
      [/-maxdepth 0/, { stdout: statReply("a.tar") }],
      [/tar -tvf/, { stdout: TAR_OUT }],
    ]);

  it("lists the top level of the whole archive", async () => {
    const plan = await extractPlanItems(target(client()), "/a.tar", null);
    expect(plan.truncated).toBe(false);
    expect(plan.items).toEqual([
      { name: "other", isDirectory: true },
      { name: "readme.txt", isDirectory: false },
      { name: "sub", isDirectory: true },
    ]);
  });

  it("flags a listing cut off by the entry cap as truncated", async () => {
    const many = Array.from(
      { length: 100_001 },
      (_, i) => `-rw-r--r-- root/root 1 2024-03-05 10:20:30 f${i}`,
    ).join("\n");
    const c = new FakeClient([
      [/-maxdepth 0/, { stdout: statReply("a.tar") }],
      [/tar -tvf/, { stdout: many }],
    ]);
    const plan = await extractPlanItems(target(c), "/a.tar", null);
    expect(plan.truncated).toBe(true);
  });

  it("names chosen entries by their own base name", async () => {
    const { items } = await extractPlanItems(target(client()), "/a.tar", [
      "/sub/run it.sh",
      "/sub",
    ]);
    expect(items).toEqual([
      { name: "run it.sh", isDirectory: false },
      { name: "sub", isDirectory: true },
    ]);
  });

  it("fails for an entry that is not in the archive", async () => {
    await expect(
      extractPlanItems(target(client()), "/a.tar", ["/nope"]),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("routes", () => {
  let server: TestServer;
  afterEach(async () => {
    await server?.close();
  });
  const FS = "/containers/s1/abc123/fs";

  async function connect(client?: FakeClient) {
    server = await startServer({ client });
    await server.request("POST", "/ssh/connect", {
      body: { sessionId: "s1", hostId: 7 },
    });
    server.client.reply(/find -H/, { stdout: statReply("a.tar") });
    server.client.reply(/tar -tvf/, { stdout: TAR_OUT });
  }

  it("extract-plan answers the top level names", async () => {
    await connect();
    const res = await server.request("POST", `${FS}/extract-plan`, {
      body: { archive: "/a.tar" },
    });
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    expect(res.body.items.map((i: { name: string }) => i.name)).toEqual([
      "other",
      "readme.txt",
      "sub",
    ]);
    const some = await server.request("POST", `${FS}/extract-plan`, {
      body: { archive: "/a.tar", entries: ["/sub/run it.sh"] },
    });
    expect(some.body.items).toEqual([
      { name: "run it.sh", isDirectory: false },
    ]);
  });

  it("extract with skip / renames stages the extraction and places it", async () => {
    await connect();
    const res = await server.request("POST", `${FS}/extract`, {
      body: {
        archive: "/a.tar",
        dest: "/out",
        skip: ["readme.txt"],
        renames: { sub: "sub (2)" },
      },
    });
    expect(res.status).toBe(200);
    const cmds = server.client.commands;
    const extractCmd = cmds.find((c) => c.includes("tar -x"));
    expect(extractCmd).toMatch(/\/out\/\.cf-extract-[0-9a-f]{12}/);
    expect(extractCmd).not.toMatch(/'\/out'/);
    const place = cmds.find((c) => c.includes("ns=$3"))!;
    expect(place).toContain(`'1' 'readme.txt' '0' 'sub' 'sub (2)'`);
    expect(cmds.at(-1)).toContain(`rm -rf -- "$1"`);
  });

  it("extract-entries drops the skipped entries before extracting", async () => {
    await connect();
    const res = await server.request("POST", `${FS}/extract-entries`, {
      body: {
        archive: "/a.tar",
        dest: "/out",
        entries: ["/readme.txt", "/sub"],
        skip: ["readme.txt"],
      },
    });
    expect(res.status).toBe(200);
    const extractCmd = server.client.commands.find((c) =>
      c.includes('tar -xf "$a"'),
    )!;
    expect(extractCmd).toContain("'1' './sub/'");
    expect(extractCmd).not.toContain("readme.txt");
  });

  it("extract-entries with everything skipped is a 400", async () => {
    await connect();
    const res = await server.request("POST", `${FS}/extract-entries`, {
      body: {
        archive: "/a.tar",
        dest: "/out",
        entries: ["/readme.txt"],
        skip: ["readme.txt"],
      },
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed choices and keeps the old path without them", async () => {
    await connect();
    const bad = await server.request("POST", `${FS}/extract`, {
      body: { archive: "/a.tar", dest: "/out", skip: ["../x"] },
    });
    expect(bad.status).toBe(400);
    const before = server.client.commands.length;
    const plain = await server.request("POST", `${FS}/extract`, {
      body: { archive: "/a.tar", dest: "/out", overwrite: true },
    });
    expect(plain.status).toBe(200);
    const added = server.client.commands.slice(before).join("\n");
    expect(added).not.toContain(".cf-extract-");
  });
});

import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import tar from "tar-stream";
import {
  changeMode,
  changeOwner,
  copyPath,
  deletePaths,
  extract,
  makeDirectory,
  movePath,
  statPath,
} from "../../src/backend/fs-ops";
import { readTextFile, writeTextFile } from "../../src/backend/fs-read-write";
import { cpReadFile, cpUpload } from "../../src/backend/cp-io";
import { packSingleFile, sanitizeTar } from "../../src/backend/tar";
import { TransferRegistry, download } from "../../src/backend/transfers";
import type { ListTarget } from "../../src/backend/fs-list";
import { FakeClient, FakeStream } from "./fake-ssh";

const caps = {
  running: true,
  exec: true,
  findPrintf: true,
  statC: true,
  tools: ["tar", "unzip", "zip", "sha256sum"],
};

const target = (
  client: FakeClient,
  capabilities: Partial<typeof caps> = {},
): ListTarget => ({
  client: client.asClient(),
  runtime: "docker",
  containerId: "abc",
  capabilities: { ...caps, ...capabilities },
});

async function tarOf(
  entries: Array<{
    header: Partial<tar.Header> & { name: string };
    body?: string;
  }>,
): Promise<Buffer> {
  const pack = tar.pack();
  for (const { header, body } of entries)
    pack.entry(header as tar.Header, body);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const c of pack) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function readAll(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Collects what is written to a cp stdin, then exits 0. */
function sink(onData: (data: Buffer) => void) {
  return (stream: FakeStream) => {
    const chunks: Buffer[] = [];
    stream.write = (d: Buffer | string) => {
      chunks.push(Buffer.from(d));
      return true;
    };
    stream.end = (d?: Buffer | string) => {
      if (d) chunks.push(Buffer.from(d));
      onData(Buffer.concat(chunks));
      stream.finish("", 0);
    };
  };
}

describe("fs-ops", () => {
  it("maps exit codes and stderr to HTTP errors", async () => {
    const client = new FakeClient([[/mkdir/, { code: 17 }]]);
    await expect(makeDirectory(target(client), "/a")).rejects.toMatchObject({
      status: 409,
      code: "EXISTS",
    });
    client.reply(/mkdir/, { code: 1, stderr: "mkdir: Permission denied" });
    await expect(makeDirectory(target(client), "/a")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("passes paths only as positional arguments", async () => {
    const client = new FakeClient();
    await movePath(target(client), "/a b", "/c'd", false);
    expect(client.commands[0]).toContain(`'/a b' '/c'\\''d' '0'`);
  });

  it("replaces the destination when overwriting", async () => {
    const client = new FakeClient();
    await copyPath(target(client), "/a", "/b", true);
    expect(client.commands[0]).toContain('then rm -rf -- "$2"; fi; cp -a');
    expect(client.commands[0]).toContain("'/a' '/b' '1'");
  });

  it("refuses dangerous input", async () => {
    const t = target(new FakeClient());
    await expect(copyPath(t, "/a/b", "/a", true)).rejects.toMatchObject({
      status: 400,
    });
    await expect(deletePaths(t, ["/"])).rejects.toMatchObject({ status: 400 });
    await expect(movePath(t, "/a", "/a/b", false)).rejects.toMatchObject({
      status: 400,
    });
    await expect(changeMode(t, "/a", "rwx", false)).rejects.toMatchObject({
      status: 400,
    });
    await expect(extract(t, "/a.exe", "/x")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("passes 3- and 4-digit octal modes (special bits) to chmod unchanged", async () => {
    for (const mode of ["755", "0755", "4755", "2755", "1777", "7777"]) {
      const client = new FakeClient();
      await changeMode(target(client), "/a", mode, false);
      expect(client.commands[0]).toContain(`'/a' '${mode}' '0'`);
    }
    const client = new FakeClient();
    await changeMode(target(client), "/d", "2775", true);
    expect(client.commands[0]).toContain("'/d' '2775' '1'");
  });

  it("clears omitted special bits explicitly so directories lose setuid/setgid", async () => {
    const client = new FakeClient();
    await changeMode(target(client), "/d", "0755", false);
    const script = client.commands[0];
    expect(script).toContain("u-s");
    expect(script).toContain("g-s");
    expect(script).toContain("o-t");
    expect(script).toContain("'/d' '0755' '0'");
  });

  it("scopes recursive chmod and chown to files or folders with find", async () => {
    const files = new FakeClient();
    await changeMode(target(files), "/d x", "0644", true, "files");
    expect(files.commands[0]).toContain('find "$P" -depth -type f -exec chmod');
    expect(files.commands[0]).toContain("{} \;");
    expect(files.commands[0]).toContain("'/d x' '0644' '1' 'f'");
    const dirs = new FakeClient();
    await changeMode(target(dirs), "/d", "755", true, "dirs");
    expect(dirs.commands[0]).toContain("'/d' '755' '1' 'd'");
    const all = new FakeClient();
    await changeMode(target(all), "/d", "755", true);
    expect(all.commands[0]).toContain("'/d' '755' '1' 'a'");
    const owner = new FakeClient();
    await changeOwner(target(owner), "/d", "bob:staff", true, "dirs");
    expect(owner.commands[0]).toContain('find "$P" -depth -type d -exec chown');
    expect(owner.commands[0]).toContain("'/d' 'bob:staff' '1' 'd'");
    const flat = new FakeClient();
    await changeOwner(target(flat), "/d", "bob", false, "files");
    expect(flat.commands[0]).toContain("'/d' 'bob' '0' 'f'");
  });

  it("rejects malformed modes", async () => {
    const t = target(new FakeClient());
    for (const mode of ["", "75", "8", "758", "12345", "7a5", "-755", "u+s"]) {
      await expect(changeMode(t, "/a", mode, false)).rejects.toMatchObject({
        status: 400,
      });
    }
  });

  it("asks before extracting over existing files", async () => {
    const client = new FakeClient([[/tar -tzf/, { code: 17 }]]);
    const t = target(client, { tools: ["tar"] });
    await expect(extract(t, "/a.tar.gz", "/d")).rejects.toMatchObject({
      status: 409,
      code: "EXISTS",
    });
    expect(client.commands[0]).toContain("'/a.tar.gz' '/d' '0'");

    const ok = new FakeClient();
    await extract(target(ok, { tools: ["tar"] }), "/a.tar.gz", "/d", true);
    expect(ok.commands[0]).toContain("'/a.tar.gz' '/d' '1'");
  });

  it("extracts into a chosen destination, passed as a positional argument", async () => {
    const client = new FakeClient();
    const dest = "/srv/my dir/$(x)";
    await extract(target(client, { tools: ["tar"] }), "/a.tar.gz", dest, true);
    expect(client.commands[0]).toContain("'/a.tar.gz' '/srv/my dir/$(x)' '1'");
  });

  it("needs a shell", async () => {
    const t = target(new FakeClient(), { exec: false });
    await expect(makeDirectory(t, "/a")).rejects.toMatchObject({
      status: 501,
      code: "NO_EXEC",
    });
  });

  it("stats through find", async () => {
    const out = ["x", "f", "7", "100.5", "640", "u", "g", "", "f", ""].join(
      "\0",
    );
    const client = new FakeClient([[/maxdepth/, { stdout: out }]]);
    const entry = await statPath(target(client), "/dir/x");
    expect(entry).toMatchObject({
      name: "x",
      size: 7,
      mode: 0o640,
      mtime: 100,
    });
  });
});

describe("editor io", () => {
  it("rejects binary content", async () => {
    const client = new FakeClient([
      [
        /maxdepth/,
        {
          stdout: ["b", "f", "3", "1", "644", "u", "g", "", "f", ""].join("\0"),
        },
      ],
      [/'cat'|cat --/, { stdout: Buffer.from([65, 0, 66]) }],
    ]);
    await expect(readTextFile(target(client), "/b")).rejects.toMatchObject({
      status: 415,
    });
  });

  it("reads text with size and mtime", async () => {
    const client = new FakeClient([
      [
        /maxdepth/,
        {
          stdout: ["a", "f", "5", "42", "644", "u", "g", "", "f", ""].join(
            "\0",
          ),
        },
      ],
      [/cat --/, { stdout: "héllo" }],
    ]);
    const file = await readTextFile(target(client), "/a");
    expect(file).toMatchObject({ content: "héllo", mtime: 42, mode: 0o644 });
  });

  it("refuses files over the editor limit", async () => {
    const client = new FakeClient([
      [
        /maxdepth/,
        {
          stdout: [
            "a",
            "f",
            String(6 * 1024 * 1024),
            "1",
            "644",
            "u",
            "g",
            "",
            "f",
            "",
          ].join("\0"),
        },
      ],
    ]);
    await expect(readTextFile(target(client), "/a")).rejects.toMatchObject({
      status: 413,
    });
  });

  it("reports a conflict when the file changed", async () => {
    const client = new FakeClient([[/\.cf-save/, { code: 18 }]]);
    await expect(
      writeTextFile(target(client), "/a", Buffer.from("x"), 5),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("feeds the content through stdin of an interactive exec", async () => {
    const client = new FakeClient([
      [/\.cf-save/, { code: 0 }],
      [
        /maxdepth/,
        {
          stdout: ["a", "f", "1", "9", "644", "u", "g", "", "f", ""].join("\0"),
        },
      ],
    ]);
    const res = await writeTextFile(
      target(client),
      "/a",
      Buffer.from("x"),
      undefined,
    );
    expect(client.commands[0]).toContain("'exec' '-i'");
    expect(client.streams[0].written.toString()).toBe("x");
    expect(res.mtime).toBe(9);
  });
});

describe("tar safety", () => {
  const owner = { uid: 1000, gid: 1001 };

  it("passes safe archives and applies the owner", async () => {
    const archive = await tarOf([
      { header: { name: "d/", type: "directory" } },
      {
        header: { name: "d/f.txt", size: 2, uid: 0, gid: 0, uname: "root" },
        body: "hi",
      },
      { header: { name: "d/l", type: "symlink", linkname: "f.txt" } },
    ]);
    const out = await readAll(sanitizeTar(Readable.from([archive]), { owner }));
    const extractor = tar.extract();
    const seen: tar.Header[] = [];
    extractor.on("entry", (h, s, next) => {
      seen.push(h);
      s.resume();
      s.on("end", next);
    });
    extractor.end(out);
    await new Promise<void>((r) => extractor.on("finish", () => r()));
    expect(seen.map((h) => h.name)).toEqual(["d/", "d/f.txt", "d/l"]);
    expect(seen[1]).toMatchObject({ uid: 1000, gid: 1001 });
  });

  it.each([
    ["traversal", { name: "../evil", size: 1 }],
    ["absolute", { name: "/etc/passwd", size: 1 }],
    ["nested traversal", { name: "a/../../evil", size: 1 }],
    [
      "absolute symlink",
      { name: "l", type: "symlink" as const, linkname: "/etc" },
    ],
    [
      "escaping symlink",
      { name: "a/l", type: "symlink" as const, linkname: "../../x" },
    ],
    ["device", { name: "dev", type: "block-device" as const }],
  ])("rejects %s", async (_label, header) => {
    const archive = await tarOf([
      { header, body: "size" in header ? "x" : undefined },
    ]);
    await expect(
      readAll(sanitizeTar(Readable.from([archive]))),
    ).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });
});

describe("cp io", () => {
  it("reads a single file through cp", async () => {
    const archive = await tarOf([
      {
        header: { name: "f.txt", size: 3, mtime: new Date(5000) },
        body: "abc",
      },
    ]);
    const client = new FakeClient([[/'cp'/, { stdout: archive }]]);
    const file = await cpReadFile(
      target(client, { exec: false }),
      "/f.txt",
      1024,
    );
    expect(file.data.toString()).toBe("abc");
    expect(file.mtime).toBe(5);
    expect(client.commands[0]).toContain("'-L' 'abc:/f.txt' '-'");
  });

  it("maps a missing path to 404", async () => {
    const client = new FakeClient([
      [
        /'cp'/,
        {
          code: 1,
          stderr: "Error: Could not find the file /x in container abc",
        },
      ],
    ]);
    await expect(
      cpReadFile(target(client, { exec: false }), "/x", 1024),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("uploads a tar with owner, using cp -a", async () => {
    let received: Buffer = Buffer.alloc(0);
    const client = new FakeClient([[/'cp'/, sink((d) => (received = d))]]);
    const body = new PassThrough();
    body.end("hello");
    await cpUpload(
      target(client),
      "/dest",
      packSingleFile("a.txt", 5, body, {
        owner: { uid: 5, gid: 6 },
        mode: 0o600,
      }),
    );
    expect(client.commands[0]).toContain("'cp' '-a' '-' 'abc:/dest'");
    const extractor = tar.extract();
    const seen: Array<{ h: tar.Header; data: string }> = [];
    extractor.on("entry", async (h, s, next) => {
      seen.push({ h, data: (await readAll(s)).toString() });
      next();
    });
    extractor.end(received);
    await new Promise<void>((r) => extractor.on("finish", () => r()));
    expect(seen[0].data).toBe("hello");
    expect(seen[0].h).toMatchObject({
      name: "a.txt",
      uid: 5,
      gid: 6,
      mode: 0o600,
    });
  });

  it("surfaces cp failures", async () => {
    const client = new FakeClient([
      [
        /'cp'/,
        (s) => {
          s.end = () => s.finish("", 1, "Error: no space left on device");
        },
      ],
    ]);
    const body = new PassThrough();
    body.end("x");
    await expect(
      cpUpload(target(client), "/d", packSingleFile("a", 1, body)),
    ).rejects.toMatchObject({ status: 507 });
  });
});

function fakeResponse() {
  const out = new PassThrough();
  const headers: Record<string, string> = {};
  const res = Object.assign(out, {
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
  });
  return { res: res as never, out, headers };
}

describe("download", () => {
  it("cuts one file out of the tar with an exact length", async () => {
    const archive = await tarOf([
      { header: { name: "дом.txt", size: 4 }, body: "data" },
    ]);
    const client = new FakeClient([[/'cp'/, { stdout: archive }]]);
    const registry = new TransferRegistry();
    const transfer = registry.start("transfer-1", "u", "download", 0);
    const { res, out, headers } = fakeResponse();
    const body = readAll(out);
    await download(target(client), transfer, res, {
      path: "/дом.txt",
      kind: "file",
    });
    expect((await body).toString()).toBe("data");
    expect(headers["content-length"]).toBe("4");
    expect(headers["content-disposition"]).toContain("filename*=UTF-8''%D0%B4");
    expect(transfer.bytes).toBe(4);
  });

  it("sends a directory as the raw tar", async () => {
    const archive = await tarOf([
      { header: { name: "d/", type: "directory" } },
      { header: { name: "d/a", size: 1 }, body: "a" },
    ]);
    const client = new FakeClient([[/'cp'/, { stdout: archive }]]);
    const registry = new TransferRegistry();
    const transfer = registry.start("transfer-2", "u", "download", 0);
    const { res, out, headers } = fakeResponse();
    const body = readAll(out);
    await download(target(client), transfer, res, {
      path: "/d",
      kind: "directory",
    });
    expect((await body).equals(archive)).toBe(true);
    expect(headers["content-disposition"]).toContain("d.tar");
  });

  it("reports a missing source as 404", async () => {
    const client = new FakeClient([
      [/'cp'/, { code: 1, stderr: "Error: No such container:path: abc:/nope" }],
    ]);
    const registry = new TransferRegistry();
    const transfer = registry.start("transfer-3", "u", "download", 0);
    const { res } = fakeResponse();
    await expect(
      download(target(client), transfer, res, { path: "/nope", kind: "file" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("TransferRegistry", () => {
  it("scopes transfers to their user and supports cancel", () => {
    const registry = new TransferRegistry();
    const t = registry.start("abcdefgh", "u1", "upload", 10);
    expect(registry.get("abcdefgh", "u2")).toBeUndefined();
    expect(registry.cancel("abcdefgh", "u2")).toBe(false);
    expect(registry.cancel("abcdefgh", "u1")).toBe(true);
    expect(t.controller.signal.aborted).toBe(true);
    expect(t.state).toBe("cancelled");
    expect(() => registry.start("bad id!", "u1", "upload", 0)).toThrow();
  });
});

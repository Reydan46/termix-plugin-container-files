import { resolve } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import tar from "tar-stream";
import type { PluginDesktopLocal } from "@termix-ssh/plugin-sdk/backend";
import { relayCopy } from "../../src/backend/c2c";
import type { ListTarget } from "../../src/backend/fs-list";
import {
  downloadToLocal,
  uploadFromLocal,
} from "../../src/backend/local-transfer";
import { sanitizeTar } from "../../src/backend/tar";
import { packWalk } from "../../src/backend/tar-local";
import { TransferRegistry } from "../../src/backend/transfers";
import { FakeClient, FakeStream } from "./fake-ssh";
import { startServer, type TestServer } from "./server";

const caps = {
  running: true,
  exec: true,
  findPrintf: true,
  statC: true,
  tools: ["tar"],
};

const target = (client: FakeClient, id: string): ListTarget => ({
  client: client.asClient(),
  runtime: "docker",
  containerId: id,
  capabilities: caps,
});

interface Item {
  header: Partial<tar.Header> & { name: string };
  body?: string;
}

async function tarOf(entries: Item[]): Promise<Buffer> {
  const pack = tar.pack();
  for (const { header, body } of entries)
    pack.entry(header as tar.Header, body);
  pack.finalize();
  return collect(pack);
}

async function collect(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

interface Seen {
  name: string;
  type?: string;
  uid?: number;
  linkname?: string;
  data: string;
}

async function entriesOf(archive: Buffer): Promise<Seen[]> {
  const out: Seen[] = [];
  const extractor = tar.extract();
  extractor.on("entry", async (h, s, next) => {
    out.push({
      name: h.name,
      type: h.type,
      uid: h.uid,
      linkname: h.linkname ?? undefined,
      data: (await collect(s)).toString(),
    });
    next();
  });
  extractor.end(archive);
  await new Promise<void>((r) => extractor.on("finish", () => r()));
  return out;
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

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("sanitizeTar rename", () => {
  it("renames only the first path segment", async () => {
    const archive = await tarOf([
      { header: { name: "dir/", type: "directory" } },
      { header: { name: "dir/sub/a.txt", size: 1 }, body: "a" },
    ]);
    const out = await entriesOf(
      await collect(
        sanitizeTar(Readable.from([archive]), {
          rename: (top) => (top === "dir" ? "dir (2)" : top),
        }),
      ),
    );
    expect(out.map((e) => e.name)).toEqual(["dir (2)/", "dir (2)/sub/a.txt"]);
  });

  it("refuses a rename that escapes", async () => {
    const archive = await tarOf([
      { header: { name: "a", size: 1 }, body: "a" },
    ]);
    await expect(
      collect(sanitizeTar(Readable.from([archive]), { rename: () => "../x" })),
    ).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });
});

function localFs(files: Record<string, string>) {
  const reads: PassThrough[] = [];
  const fs = {
    walk: async (roots: string[]) => ({
      files: Object.entries(files).map(([rel, data]) => ({
        localPath: `/local/${rel}`,
        relativePath: rel,
        size: data.length,
      })),
      emptyDirs: roots.length ? ["/local/photos/empty"] : [],
      totalBytes: Object.values(files).reduce((n, d) => n + d.length, 0),
    }),
    openRead: async (path: string) => {
      const rel = path.replace("/local/", "");
      const stream = new PassThrough();
      reads.push(stream);
      stream.end(files[rel]);
      return { stream, size: files[rel].length };
    },
  };
  return { fs: fs as unknown as PluginDesktopLocal["fs"], reads };
}

describe("packWalk", () => {
  it("packs files, parents and empty dirs with the owner", async () => {
    const { fs } = localFs({
      "photos/a.txt": "aaa",
      "photos/deep/b.txt": "bb",
    });
    const walk = await fs.walk(["/local/photos"]);
    let bytes = 0;
    const pack = packWalk(walk, ["/local/photos"], (p) => fs.openRead(p), {
      owner: { uid: 7, gid: 8 },
      onBytes: (n) => (bytes += n),
    });
    const out = await entriesOf(await collect(pack));
    expect(out.map((e) => e.name)).toEqual([
      "photos/",
      "photos/deep/",
      "photos/empty/",
      "photos/a.txt",
      "photos/deep/b.txt",
    ]);
    expect(out.every((e) => e.uid === 7)).toBe(true);
    expect(out.find((e) => e.name === "photos/a.txt")?.data).toBe("aaa");
    expect(bytes).toBe(5);
  });

  it("stops and closes the open file when cancelled", async () => {
    const controller = new AbortController();
    const hanging = new PassThrough();
    const pack = packWalk(
      {
        files: [{ localPath: "/x", relativePath: "x", size: 100 }],
        emptyDirs: [],
      },
      ["/x"],
      async () => ({ stream: hanging, size: 100 }),
      { signal: controller.signal },
    );
    const done = collect(pack).catch((e) => e);
    await tick();
    controller.abort();
    expect(await done).toMatchObject({ code: "CANCELLED" });
    expect(hanging.destroyed).toBe(true);
  });
});

describe("uploadFromLocal", () => {
  it("sends one tar with renames and the directory owner", async () => {
    const { fs } = localFs({ "photos/a.txt": "aaa" });
    let received: Buffer = Buffer.alloc(0);
    const client = new FakeClient([
      [/%u %g/, { stdout: "1000 1001\n" }],
      [/'cp'/, sink((d) => (received = d))],
    ]);
    const transfer = new TransferRegistry().start(
      "up-12345678",
      "u",
      "local-up",
      0,
    );
    const result = await uploadFromLocal(target(client, "abc"), fs, transfer, {
      dir: "/data",
      localPaths: ["/local/photos"],
      renames: { photos: "photos (2)" },
    });
    expect(result.files).toBe(1);
    const out = await entriesOf(received);
    expect(out.map((e) => e.name)).toEqual([
      "photos (2)/",
      "photos (2)/empty/",
      "photos (2)/a.txt",
    ]);
    expect(out.every((e) => e.uid === 1000)).toBe(true);
    expect(transfer.total).toBe(3);
    expect(transfer.bytes).toBe(3);
    expect(client.commands.some((c) => c.includes("'abc:/data'"))).toBe(true);
  });

  it("uploads a lone file under a temporary name and moves it", async () => {
    const { fs } = localFs({ "n.txt": "hello" });
    let received: Buffer = Buffer.alloc(0);
    const client = new FakeClient([
      [/%u %g/, { stdout: "0 0\n" }],
      [/'cp'/, sink((d) => (received = d))],
    ]);
    const transfer = new TransferRegistry().start(
      "up-87654321",
      "u",
      "local-up",
      0,
    );
    // emptyDirs is reported by the fake whenever roots exist; none for a file.
    (fs as unknown as { walk: unknown }).walk = async () => ({
      files: [{ localPath: "/local/n.txt", relativePath: "n.txt", size: 5 }],
      emptyDirs: [],
      totalBytes: 5,
    });
    await uploadFromLocal(target(client, "abc"), fs, transfer, {
      dir: "/data",
      localPaths: ["/local/n.txt"],
    });
    const out = await entriesOf(received);
    expect(out.map((e) => e.name)).toEqual([".cf-part-up-87654-n.txt"]);
    const mv = client.commands.find((c) => c.includes("mv -f"));
    expect(mv).toContain("'/data/.cf-part-up-87654-n.txt' '/data/n.txt'");
  });

  it("destroys the channel and removes the temp file on cancel", async () => {
    const hanging = new PassThrough();
    const fs = {
      walk: async () => ({
        files: [{ localPath: "/local/big", relativePath: "big", size: 1000 }],
        emptyDirs: [],
        totalBytes: 1000,
      }),
      openRead: async () => ({ stream: hanging, size: 1000 }),
    } as unknown as PluginDesktopLocal["fs"];
    const client = new FakeClient([
      [/%u %g/, { stdout: "0 0\n" }],
      [
        /'cp'/,
        (s: FakeStream) => {
          s.write = () => true;
        },
      ],
    ]);
    const transfer = new TransferRegistry().start(
      "up-cancel-1",
      "u",
      "local-up",
      0,
    );
    const run = uploadFromLocal(target(client, "abc"), fs, transfer, {
      dir: "/data",
      localPaths: ["/local/big"],
    }).catch((e) => e);
    await tick(40);
    transfer.controller.abort();
    expect(await run).toMatchObject({ code: "CANCELLED" });
    const cp = client.streams.find((_, i) => /'cp'/.test(client.commands[i]));
    expect(cp?.destroyed).toBe(true);
    expect(hanging.destroyed).toBe(true);
    expect(client.commands.some((c) => c.includes("rm -f"))).toBe(true);
  });
});

function fakeLocalDisk() {
  const written = new Map<string, string>();
  const aborted: string[] = [];
  const dirs: string[] = [];
  const fs = {
    ensureDir: async (dir: string) => {
      dirs.push(dir);
      return dir;
    },
    openDownload: async (o: { destPath: string }) => {
      const chunks: Buffer[] = [];
      const stream = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk);
          cb();
        },
      });
      return {
        path: o.destPath,
        stream,
        publish: async () => {
          written.set(o.destPath, Buffer.concat(chunks).toString());
          return o.destPath;
        },
        abort: async () => {
          aborted.push(o.destPath);
        },
      };
    },
  } as unknown as PluginDesktopLocal["fs"];
  return { fs, written, aborted, dirs };
}

const root = resolve("/dl");

describe("downloadToLocal", () => {
  it("unpacks folders and files, counts progress, skips links", async () => {
    const archive = await tarOf([
      { header: { name: "proj/", type: "directory" } },
      { header: { name: "proj/a.txt", size: 3 }, body: "abc" },
      {
        header: { name: "proj/ln", type: "symlink", linkname: "a.txt" },
      },
      { header: { name: "proj/sub/", type: "directory" } },
      { header: { name: "proj/sub/b.txt", size: 2 }, body: "bb" },
    ]);
    const client = new FakeClient([
      [/du -sb/, { stdout: `${archive.length}\t/proj\n` }],
      [/'cp'/, { stdout: archive }],
    ]);
    const disk = fakeLocalDisk();
    const transfer = new TransferRegistry().start(
      "dl-12345678",
      "u",
      "local-down",
      0,
    );
    const result = await downloadToLocal(
      target(client, "abc"),
      disk.fs,
      transfer,
      {
        paths: ["/proj"],
        localDir: root,
        renames: { proj: "proj (2)" },
      },
    );
    expect(result).toEqual({
      files: 2,
      dirs: 2,
      skipped: ["proj/ln"],
      bytesWritten: 5,
    });
    expect(disk.written.get(resolve(root, "proj (2)", "a.txt"))).toBe("abc");
    expect(disk.written.get(resolve(root, "proj (2)", "sub", "b.txt"))).toBe(
      "bb",
    );
    expect(transfer.total).toBe(archive.length);
    expect(transfer.bytes).toBe(archive.length);
  });

  it("refuses entries that escape the folder and writes nothing", async () => {
    const archive = await tarOf([
      { header: { name: "../evil.txt", size: 1 }, body: "x" },
    ]);
    const client = new FakeClient([[/'cp'/, { stdout: archive }]]);
    const disk = fakeLocalDisk();
    const transfer = new TransferRegistry().start(
      "dl-evil-001",
      "u",
      "local-down",
      0,
    );
    await expect(
      downloadToLocal(target(client, "abc"), disk.fs, transfer, {
        paths: ["/x"],
        localDir: root,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    expect(disk.written.size).toBe(0);
    expect(disk.aborted).toEqual([]);
  });

  it("refuses absolute entries", async () => {
    const archive = await tarOf([
      { header: { name: "/etc/passwd", size: 1 }, body: "x" },
    ]);
    const client = new FakeClient([[/'cp'/, { stdout: archive }]]);
    const disk = fakeLocalDisk();
    const transfer = new TransferRegistry().start(
      "dl-abs-0001",
      "u",
      "local-down",
      0,
    );
    await expect(
      downloadToLocal(target(client, "abc"), disk.fs, transfer, {
        paths: ["/x"],
        localDir: root,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    expect(disk.written.size).toBe(0);
  });

  it("aborts the partial file and closes the channel on cancel", async () => {
    const archive = await tarOf([
      { header: { name: "big.bin", size: 1500 }, body: "z".repeat(1500) },
    ]);
    const client = new FakeClient([
      [
        /'cp'/,
        (s: FakeStream) => {
          // Header and part of the body, then nothing: a stalled transfer.
          setImmediate(() => s.emit("data", archive.subarray(0, 700)));
        },
      ],
    ]);
    const disk = fakeLocalDisk();
    const transfer = new TransferRegistry().start(
      "dl-cancel-01",
      "u",
      "local-down",
      0,
    );
    const run = downloadToLocal(target(client, "abc"), disk.fs, transfer, {
      paths: ["/big.bin"],
      localDir: root,
    }).catch((e) => e);
    await tick(60);
    transfer.controller.abort();
    expect(await run).toMatchObject({ code: "CANCELLED" });
    expect(disk.aborted).toEqual([resolve(root, "big.bin")]);
    expect(disk.written.size).toBe(0);
    const cp = client.streams.find((_, i) => /'cp'/.test(client.commands[i]));
    expect(cp?.destroyed).toBe(true);
  });

  it("maps a cp failure and leaves nothing behind", async () => {
    const client = new FakeClient([
      [/'cp'/, { code: 1, stderr: "Error: Could not find the file /nope" }],
    ]);
    const disk = fakeLocalDisk();
    const transfer = new TransferRegistry().start(
      "dl-fail-001",
      "u",
      "local-down",
      0,
    );
    await expect(
      downloadToLocal(target(client, "abc"), disk.fs, transfer, {
        paths: ["/nope"],
        localDir: root,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(disk.written.size).toBe(0);
  });
});

describe("relayCopy", () => {
  const source = (archive: Buffer) =>
    [/'cp' '-L' 'a:\/src' '-'/, { stdout: archive }] as const;

  it("copies bytes between containers with renames and owner", async () => {
    const archive = await tarOf([
      { header: { name: "src/", type: "directory" } },
      { header: { name: "src/f.txt", size: 4 }, body: "data" },
    ]);
    let received: Buffer = Buffer.alloc(0);
    const client = new FakeClient([
      [...source(archive)],
      [/'cp' '-a' '-' 'b:\/dest'/, sink((d) => (received = d))],
      [/%u %g/, { stdout: "33 44\n" }],
      [/du -sb/, { stdout: `${archive.length}\t/src\n` }],
    ]);
    const transfer = new TransferRegistry().start("c2c-1234567", "u", "c2c", 0);
    const result = await relayCopy(
      target(client, "a"),
      target(client, "b"),
      transfer,
      { paths: ["/src"], dir: "/dest", renames: { src: "src (2)" } },
    );
    expect(result).toEqual({ copied: 1 });
    const out = await entriesOf(received);
    const part = ".cf-part-c2c-1234-src (2)";
    expect(out.map((e) => e.name)).toEqual([`${part}/`, `${part}/f.txt`]);
    expect(
      client.commands.some((c) =>
        c.includes(`'/dest/${part}' '/dest/src (2)'`),
      ),
    ).toBe(true);
    expect(out.every((e) => e.uid === 33)).toBe(true);
    expect(out[1].data).toBe("data");
    expect(transfer.bytes).toBe(archive.length);
    expect(transfer.total).toBe(archive.length);
  });

  it("writes in place when the target name already exists", async () => {
    const archive = await tarOf([
      { header: { name: "src", size: 2 }, body: "hi" },
    ]);
    let received: Buffer = Buffer.alloc(0);
    const client = new FakeClient([
      [...source(archive)],
      [/'cp' '-a' '-' 'b:\/dest'/, sink((d) => (received = d))],
      [/-e "\$d\/\$n"/, { stdout: "src\0" }],
    ]);
    const transfer = new TransferRegistry().start(
      "c2c-exist-01",
      "u",
      "c2c",
      0,
    );
    await relayCopy(target(client, "a"), target(client, "b"), transfer, {
      paths: ["/src"],
      dir: "/dest",
    });
    expect((await entriesOf(received)).map((e) => e.name)).toEqual(["src"]);
  });

  it("removes the temporary copy when the source fails", async () => {
    const client = new FakeClient([
      [
        /'cp' '-L' 'a:\/src' '-'/,
        { code: 1, stderr: "Error: Could not find the file /src" },
      ],
      [
        /'cp' '-a' '-' 'b:\/dest'/,
        (s: FakeStream) => {
          s.write = () => true;
        },
      ],
    ]);
    const transfer = new TransferRegistry().start(
      "c2c-clean-01",
      "u",
      "c2c",
      0,
    );
    await expect(
      relayCopy(target(client, "a"), target(client, "b"), transfer, {
        paths: ["/src"],
        dir: "/dest",
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      client.commands.some(
        (c) =>
          c.includes("rm -rf") && c.includes("/dest/.cf-part-c2c-clea-src"),
      ),
    ).toBe(true);
    expect(client.commands.some((c) => c.includes("mv -f"))).toBe(false);
  });

  it("keeps hard links in a container copy and renames their target", async () => {
    const archive = await tarOf([
      { header: { name: "d/", type: "directory" } },
      { header: { name: "d/a", size: 1 }, body: "x" },
      { header: { name: "d/b", type: "link", linkname: "d/a" } },
    ]);
    let received: Buffer = Buffer.alloc(0);
    const client = new FakeClient([
      [/'cp' '-L' 'a:\/d' '-'/, { stdout: archive }],
      [/'cp' '-a' '-' 'b:\/dest'/, sink((d) => (received = d))],
    ]);
    const transfer = new TransferRegistry().start(
      "c2c-hard-001",
      "u",
      "c2c",
      0,
    );
    await relayCopy(target(client, "a"), target(client, "b"), transfer, {
      paths: ["/d"],
      dir: "/dest",
      renames: { d: "e" },
    });
    const out = await entriesOf(received);
    const part = ".cf-part-c2c-hard-e";
    expect(out.map((e) => [e.name, e.type])).toEqual([
      [`${part}/`, "directory"],
      [`${part}/a`, "file"],
      [`${part}/b`, "link"],
    ]);
    expect(out[2].linkname).toBe(`${part}/a`);
  });

  it("rejects hard links unless allowed", async () => {
    const archive = await tarOf([
      { header: { name: "b", type: "link", linkname: "a" } },
    ]);
    const input = Readable.from([archive]);
    await expect(collect(sanitizeTar(input))).rejects.toMatchObject({
      code: "UNSAFE_ARCHIVE",
    });
  });

  it("skips listed names", async () => {
    const client = new FakeClient([]);
    const transfer = new TransferRegistry().start(
      "c2c-skip-001",
      "u",
      "c2c",
      0,
    );
    const result = await relayCopy(
      target(client, "a"),
      target(client, "b"),
      transfer,
      { paths: ["/src"], dir: "/dest", skip: ["src"] },
    );
    expect(result.copied).toBe(0);
    expect(client.commands.some((c) => c.includes("'cp'"))).toBe(false);
  });

  it("rejects copying a folder into itself", async () => {
    const client = new FakeClient([]);
    const transfer = new TransferRegistry().start(
      "c2c-self-001",
      "u",
      "c2c",
      0,
    );
    await expect(
      relayCopy(target(client, "a"), target(client, "a"), transfer, {
        paths: ["/src"],
        dir: "/src/inner",
      }),
    ).rejects.toMatchObject({ code: "COPY_INTO_SELF" });
  });

  it("fails cleanly and closes the target channel when the source fails", async () => {
    const client = new FakeClient([
      [
        /'cp' '-L' 'a:\/src' '-'/,
        { code: 1, stderr: "Error: Could not find the file /src" },
      ],
      [
        /'cp' '-a' '-' 'b:\/dest'/,
        (s: FakeStream) => {
          s.write = () => true;
        },
      ],
    ]);
    const transfer = new TransferRegistry().start(
      "c2c-fail-001",
      "u",
      "c2c",
      0,
    );
    await expect(
      relayCopy(target(client, "a"), target(client, "b"), transfer, {
        paths: ["/src"],
        dir: "/dest",
      }),
    ).rejects.toMatchObject({ status: 404 });
    const dst = client.streams.find((_, i) =>
      /'-a' '-'/.test(client.commands[i]),
    );
    expect(dst?.destroyed).toBe(true);
  });

  it("destroys both channels on cancel", async () => {
    const client = new FakeClient([
      [
        /'cp' '-L' 'a:\/src' '-'/,
        (s: FakeStream) => {
          setImmediate(() => s.emit("data", Buffer.alloc(512)));
        },
      ],
      [
        /'cp' '-a' '-' 'b:\/dest'/,
        (s: FakeStream) => {
          s.write = () => true;
        },
      ],
    ]);
    const transfer = new TransferRegistry().start(
      "c2c-cancel-1",
      "u",
      "c2c",
      0,
    );
    const run = relayCopy(target(client, "a"), target(client, "b"), transfer, {
      paths: ["/src"],
      dir: "/dest",
    }).catch((e) => e);
    await tick(60);
    transfer.controller.abort();
    expect(await run).toMatchObject({ code: "CANCELLED" });
    const bySide = (re: RegExp) =>
      client.streams.find((_, i) => re.test(client.commands[i]));
    expect(bySide(/'-L'/)?.destroyed).toBe(true);
    expect(bySide(/'-a' '-'/)?.destroyed).toBe(true);
  });
  it("aborts both sides when the cancel lands while the target channel opens", async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    const transfer = new TransferRegistry().start(
      "c2c-race-001",
      "u",
      "c2c",
      0,
    );
    const client = new FakeClient([
      [
        /'cp' '-L' 'a:\/src' '-'/,
        (s: FakeStream) => {
          setImmediate(() => s.emit("data", Buffer.alloc(512)));
        },
      ],
      [
        /'cp' '-a' '-' 'b:\/dest'/,
        (s: FakeStream) => {
          s.write = () => true;
          transfer.controller.abort();
        },
      ],
    ]);
    try {
      await expect(
        relayCopy(target(client, "a"), target(client, "b"), transfer, {
          paths: ["/src"],
          dir: "/dest",
        }),
      ).rejects.toMatchObject({ code: "CANCELLED" });
      await tick(30);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    const bySide = (re: RegExp) =>
      client.streams.find((_, i) => re.test(client.commands[i]));
    expect(bySide(/'-L'/)?.destroyed).toBe(true);
    expect(bySide(/'-a' '-'/)?.destroyed).toBe(true);
    expect(client.commands.some((c) => c.includes("mv -f"))).toBe(false);
    expect(rejections).toEqual([]);
  });
});

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function connect(s: TestServer) {
  return s.request("POST", "/ssh/connect", {
    body: { sessionId: "s1", hostId: 7 },
  });
}

describe("transfer routes", () => {
  it("copies between containers over the relay", async () => {
    server = await startServer();
    await connect(server);
    const archive = await tarOf([
      { header: { name: "f", size: 2 }, body: "hi" },
    ]);
    let received: Buffer = Buffer.alloc(0);
    server.client.reply(/'cp' '-L' 'abc123:\/src\/f' '-'/, { stdout: archive });
    server.client.reply(
      /'cp' '-a' '-' 'other1:\/dest'/,
      sink((d) => (received = d)),
    );
    server.client.reply(/%u %g/, { stdout: "5 6\n" });
    const r = await server.request("POST", "/containers/s1/copy", {
      body: {
        from: { containerId: "abc123", paths: ["/src/f"] },
        to: { containerId: "other1", dir: "/dest" },
        renames: { f: "f (2)" },
        transferId: "c2c-route-01",
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ success: true, copied: 1 });
    expect((await entriesOf(received)).map((e) => e.name)).toEqual([
      ".cf-part-c2c-rout-f (2)",
    ]);
    const status = await server.request("GET", "/transfers/c2c-route-01");
    expect(status.body).toMatchObject({ direction: "c2c", state: "done" });
  });

  it("rejects another user's session and bad bodies", async () => {
    server = await startServer();
    await connect(server);
    const body = {
      from: { containerId: "abc123", paths: ["/a"] },
      to: { containerId: "other1", dir: "/d" },
      transferId: "c2c-route-02",
    };
    const other = await server.request("POST", "/containers/s1/copy", {
      user: "user-2",
      body,
    });
    expect(other.status).toBe(400);
    expect(other.body.code).toBe("NO_SESSION");
    const bad = await server.request("POST", "/containers/s1/copy", {
      body: { ...body, from: { containerId: "x y", paths: ["/a"] } },
    });
    expect(bad.status).toBe(400);
    const badName = await server.request("POST", "/containers/s1/copy", {
      body: { ...body, renames: { a: "../b" }, transferId: "c2c-route-03" },
    });
    expect(badName.status).toBe(400);
  });

  it("answers 404 for local routes outside the desktop app", async () => {
    server = await startServer();
    await connect(server);
    for (const [method, path] of [
      ["GET", "/local/home"],
      ["POST", "/local/list"],
      ["POST", "/local/transfer/upload"],
      ["POST", "/local/transfer/download"],
    ] as const) {
      const r = await server.request(method, path, { body: {} });
      expect(r.status, path).toBe(404);
    }
  });

  it("serves the local bridge and uploads in the desktop app", async () => {
    const { fs } = localFs({ "n.txt": "hello" });
    (fs as unknown as { walk: unknown }).walk = async () => ({
      files: [{ localPath: "/local/n.txt", relativePath: "n.txt", size: 5 }],
      emptyDirs: [],
      totalBytes: 5,
    });
    const local = {
      available: () => true,
      info: async () => ({
        home: "/home/me",
        separator: "/",
        platform: "linux",
      }),
      fs: {
        ...fs,
        exists: async (p: string[]) => p.slice(0, 1),
        list: async () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
      },
    } as unknown as PluginDesktopLocal;
    server = await startServer({ mock: { desktopLocal: local } });
    await connect(server);

    const home = await server.request("GET", "/local/home");
    expect(home.body).toEqual({
      success: true,
      home: "/home/me",
      separator: "/",
      platform: "linux",
    });
    const exists = await server.request("POST", "/local/exists", {
      body: { paths: ["/a", "/b"] },
    });
    expect(exists.body).toEqual({ success: true, existing: ["/a"] });
    const list = await server.request("POST", "/local/list", {
      body: { path: "/root" },
    });
    expect(list.body).toEqual({
      success: false,
      error: "denied",
      code: "EACCES",
    });

    let received: Buffer = Buffer.alloc(0);
    server.client.reply(
      /'cp'/,
      sink((d) => (received = d)),
    );
    server.client.reply(/%u %g/, { stdout: "0 0\n" });
    const up = await server.request("POST", "/local/transfer/upload", {
      body: {
        sessionId: "s1",
        containerId: "abc123",
        dir: "/data",
        localPaths: ["/local/n.txt"],
        transferId: "up-route-001",
      },
    });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body).toMatchObject({ success: true, files: 1, bytes: 5 });
    expect((await entriesOf(received))[0].name).toMatch(
      /^\.cf-part-up-route-n\.txt$/,
    );

    const foreign = await server.request("POST", "/local/transfer/upload", {
      user: "user-2",
      body: {
        sessionId: "s1",
        containerId: "abc123",
        dir: "/data",
        localPaths: ["/local/n.txt"],
        transferId: "up-route-002",
      },
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe("NO_SESSION");
  });
});

import { resolve } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import tar from "tar-stream";
import type { PluginDesktopLocal } from "@termix-ssh/plugin-sdk/backend";
import {
  RemoteContainer,
  remoteTransferId,
} from "../../src/backend/remote-side";
import type { FakeStream } from "./fake-ssh";
import { startServer, type TestServer } from "./server";

type PluginFetch = PluginDesktopLocal["pluginFetch"];
type FetchInit = NonNullable<Parameters<PluginFetch>[2]>;
type FetchResult = Awaited<ReturnType<PluginFetch>>;
type LocalFs = PluginDesktopLocal["fs"];

const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function start(options?: Parameters<typeof startServer>[0]) {
  const s = await startServer(options);
  servers.push(s);
  return s;
}

/** A pluginFetch that sends the call to another test server over HTTP. */
function forwardTo(remote: TestServer): PluginFetch {
  return async (origin, subPath, init: FetchInit = {}) => {
    expect(origin).toBe("remote");
    const body = init.body;
    const response = await fetch(remote.url(subPath), {
      method: init.method,
      headers: { "x-test-user": "user-1", ...init.headers },
      body:
        body === undefined || typeof body === "string" || Buffer.isBuffer(body)
          ? (body as string | undefined)
          : (Readable.toWeb(body as Readable) as never),
      duplex: "half",
      signal: init.signal,
    } as RequestInit);
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      body: response.body as unknown as AsyncIterable<Uint8Array>,
      text: () => response.text(),
    };
  };
}

/** The desktop backend (local files on this machine) linked to a server. */
async function pair(fs: LocalFs) {
  const remote = await start();
  const local = await start({
    mock: {
      desktopLocal: {
        available: () => true,
        pluginFetch: forwardTo(remote),
        fs,
      } as PluginDesktopLocal,
    },
  });
  const connected = await remote.request("POST", "/ssh/connect", {
    body: { sessionId: "s1", hostId: 7 },
  });
  expect(connected.status, JSON.stringify(connected.body)).toBe(200);
  return { remote, local };
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

interface Item {
  header: Partial<tar.Header> & { name: string };
  body?: string;
}

async function collect(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function tarOf(entries: Item[]): Promise<Buffer> {
  const pack = tar.pack();
  for (const { header, body } of entries)
    pack.entry(header as tar.Header, body);
  pack.finalize();
  return collect(pack);
}

interface Seen {
  name: string;
  type?: string;
  uid?: number;
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
      data: (await collect(s)).toString(),
    });
    next();
  });
  extractor.end(archive);
  await new Promise<void>((r) => extractor.on("finish", () => r()));
  return out;
}

async function waitFor(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A local disk that walks and reads the given files. */
function localFiles(files: Record<string, string>, emptyDirs: string[] = []) {
  return {
    walk: async () => ({
      files: Object.entries(files).map(([rel, data]) => ({
        localPath: `/local/${rel}`,
        relativePath: rel,
        size: data.length,
      })),
      emptyDirs,
      totalBytes: Object.values(files).reduce((n, d) => n + d.length, 0),
    }),
    openRead: async (path: string) => {
      const rel = path.replace("/local/", "");
      const stream = new PassThrough();
      stream.end(files[rel]);
      return { stream, size: files[rel].length };
    },
  } as unknown as LocalFs;
}

function fakeLocalDisk() {
  const written = new Map<string, string>();
  const aborted: string[] = [];
  const fs = {
    ensureDir: async (dir: string) => dir,
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
  } as unknown as LocalFs;
  return { fs, written, aborted };
}

const root = resolve("/dl");
const upload = (id: string, extra: Record<string, unknown> = {}) => ({
  sessionId: "s1",
  origin: "remote",
  containerId: "abc123",
  dir: "/data",
  localPaths: ["/local/photos"],
  transferId: id,
  ...extra,
});
const download = (id: string, extra: Record<string, unknown> = {}) => ({
  sessionId: "s1",
  origin: "remote",
  containerId: "abc123",
  paths: ["/proj"],
  localDir: root,
  transferId: id,
  ...extra,
});

describe("local pane to a container on the server", () => {
  it("uploads a folder as one tar written by the server", async () => {
    const { remote, local } = await pair(
      localFiles({ "photos/a.txt": "aaa" }, ["/local/photos/empty"]),
    );
    let received: Buffer = Buffer.alloc(0);
    remote.client.reply(/%u %g/, { stdout: "1000 1001\n" });
    remote.client.reply(
      /'cp'/,
      sink((d) => (received = d)),
    );

    const r = await local.request("POST", "/local/transfer/upload", {
      body: upload("up-halves1", { renames: { photos: "photos (2)" } }),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      success: true,
      bytes: 3,
      files: 1,
      dirs: 1,
    });

    const out = await entriesOf(received);
    expect(out.map((e) => e.name)).toEqual([
      "photos (2)/",
      "photos (2)/empty/",
      "photos (2)/a.txt",
    ]);
    // The server applies the owner of the destination, not the desktop.
    expect(out.every((e) => e.uid === 1000)).toBe(true);
    expect(
      remote.client.commands.some((c) => c.includes("'abc123:/data'")),
    ).toBe(true);

    // The local registry shows the job; the server has its own half.
    const status = await local.request("GET", "/transfers/up-halves1");
    expect(status.body).toMatchObject({
      direction: "local-up",
      state: "done",
      total: 3,
      bytes: 3,
    });
    const half = await remote.request("GET", "/transfers/up-halves1-u");
    expect(half.body).toMatchObject({ direction: "upload", state: "done" });
  });

  it("uploads a lone file under a temporary name and moves it", async () => {
    const { remote, local } = await pair(localFiles({ "n.txt": "hello" }));
    let received: Buffer = Buffer.alloc(0);
    remote.client.reply(/%u %g/, { stdout: "0 0\n" });
    remote.client.reply(
      /'cp'/,
      sink((d) => (received = d)),
    );

    const r = await local.request("POST", "/local/transfer/upload", {
      body: upload("up-halves2", { localPaths: ["/local/n.txt"] }),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ bytes: 5, files: 1, dirs: 0 });

    const out = await entriesOf(received);
    expect(out.map((e) => e.name)).toEqual([".cf-part-up-halve-n.txt"]);
    expect(out[0].data).toBe("hello");
    const mv = remote.client.commands.find((c) => c.includes("mv -f"));
    expect(mv).toContain("'/data/.cf-part-up-halve-n.txt' '/data/n.txt'");
    const status = await local.request("GET", "/transfers/up-halves2");
    expect(status.body).toMatchObject({ state: "done", total: 5, bytes: 5 });
  });

  it("uploads nothing when every item is skipped", async () => {
    const { remote, local } = await pair(localFiles({ "n.txt": "hello" }));
    const r = await local.request("POST", "/local/transfer/upload", {
      body: upload("up-halves3", {
        localPaths: ["/local/n.txt"],
        skip: ["n.txt"],
      }),
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ files: 0, dirs: 0 });
    expect(remote.client.commands.some((c) => /'cp'/.test(c))).toBe(false);
  });

  it("downloads into the local folder and counts the tar bytes", async () => {
    const archive = await tarOf([
      { header: { name: "proj/", type: "directory" } },
      { header: { name: "proj/a.txt", size: 3 }, body: "abc" },
      { header: { name: "proj/sub/", type: "directory" } },
      { header: { name: "proj/sub/b.txt", size: 2 }, body: "bb" },
    ]);
    const disk = fakeLocalDisk();
    const { remote, local } = await pair(disk.fs);
    remote.client.reply(/du -sb/, { stdout: `${archive.length}\t/proj\n` });
    remote.client.reply(/'cp'/, { stdout: archive });

    const r = await local.request("POST", "/local/transfer/download", {
      body: download("dl-halves1", { renames: { proj: "proj (2)" } }),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      success: true,
      files: 2,
      dirs: 2,
      skipped: [],
      bytesWritten: 5,
      bytes: archive.length,
    });
    expect(disk.written.get(resolve(root, "proj (2)", "a.txt"))).toBe("abc");
    expect(disk.written.get(resolve(root, "proj (2)", "sub", "b.txt"))).toBe(
      "bb",
    );

    const status = await local.request("GET", "/transfers/dl-halves1");
    expect(status.body).toMatchObject({
      direction: "local-down",
      state: "done",
      total: archive.length,
      bytes: archive.length,
    });
    const half = await remote.request("GET", "/transfers/dl-halves1-d0");
    expect(half.body).toMatchObject({ direction: "download", state: "done" });
  });

  it("downloads a lone file the same way", async () => {
    const archive = await tarOf([
      { header: { name: "f.bin", size: 4 }, body: "data" },
    ]);
    const disk = fakeLocalDisk();
    const { remote, local } = await pair(disk.fs);
    remote.client.reply(/'cp'/, { stdout: archive });
    const r = await local.request("POST", "/local/transfer/download", {
      body: download("dl-halves2", { paths: ["/f.bin"] }),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ files: 1, bytesWritten: 4 });
    expect(disk.written.get(resolve(root, "f.bin"))).toBe("data");
  });

  it("raises NOTHING_WRITTEN when only links came down", async () => {
    const archive = await tarOf([
      { header: { name: "ln", type: "symlink", linkname: "x" } },
    ]);
    const disk = fakeLocalDisk();
    const { remote, local } = await pair(disk.fs);
    remote.client.reply(/'cp'/, { stdout: archive });
    const r = await local.request("POST", "/local/transfer/download", {
      body: download("dl-halves3", { paths: ["/ln"] }),
    });
    expect(r.status).toBe(500);
    expect(r.body.code).toBe("NOTHING_WRITTEN");
    expect(disk.written.size).toBe(0);
    const status = await local.request("GET", "/transfers/dl-halves3");
    expect(status.body.state).toBe("error");
  });

  it("passes the server's error through", async () => {
    const disk = fakeLocalDisk();
    const { remote, local } = await pair(disk.fs);
    remote.client.reply(/'cp'/, {
      code: 1,
      stderr: "Error: Could not find the file /nope",
    });
    const r = await local.request("POST", "/local/transfer/download", {
      body: download("dl-halves4", { paths: ["/nope"] }),
    });
    expect(r.status).toBe(404);
    expect(disk.written.size).toBe(0);
  });

  it("refuses the root", async () => {
    const { local } = await pair(fakeLocalDisk().fs);
    const r = await local.request("POST", "/local/transfer/download", {
      body: download("dl-halves5", { paths: ["/"] }),
    });
    expect(r.status).toBe(400);
  });

  it("cancels the upload on both sides", async () => {
    const hanging = new PassThrough();
    const fs = {
      walk: async () => ({
        files: [{ localPath: "/local/big", relativePath: "big", size: 1000 }],
        emptyDirs: [],
        totalBytes: 1000,
      }),
      openRead: async () => ({ stream: hanging, size: 1000 }),
    } as unknown as LocalFs;
    const { remote, local } = await pair(fs);
    remote.client.reply(/%u %g/, { stdout: "0 0\n" });
    remote.client.reply(/'cp'/, (s: FakeStream) => {
      s.write = () => true;
    });

    const run = local.request("POST", "/local/transfer/upload", {
      body: upload("up-halves4", { localPaths: ["/local/big"] }),
    });
    // The request only reaches the server with the first bytes of the body.
    await waitFor(() => hanging.listenerCount("data") > 0);
    hanging.write("part");
    await waitFor(() => remote.client.commands.some((c) => /'cp'/.test(c)));
    const cancelled = await local.request(
      "POST",
      "/transfers/up-halves4/cancel",
    );
    expect(cancelled.status).toBe(200);

    const r = await run;
    expect(r.body.code).toBe("CANCELLED");
    const cp = () =>
      remote.client.streams.find((_, i) =>
        /'cp'/.test(remote.client.commands[i]),
      );
    await waitFor(() => cp()?.destroyed === true);
    expect(cp()?.destroyed).toBe(true);
    expect(hanging.destroyed).toBe(true);
    await waitFor(() =>
      remote.client.commands.some((c) => c.includes("rm -f")),
    );
    expect(remote.client.commands.some((c) => c.includes("rm -f"))).toBe(true);
    const half = await remote.request("GET", "/transfers/up-halves4-u");
    expect(["cancelled", "error"]).toContain(half.body.state);
  });

  it("cancels the download on both sides", async () => {
    const archive = await tarOf([
      { header: { name: "big.bin", size: 1500 }, body: "z".repeat(1500) },
    ]);
    const disk = fakeLocalDisk();
    const { remote, local } = await pair(disk.fs);
    remote.client.reply(/'cp'/, (s: FakeStream) => {
      // Header and part of the body, then nothing: a stalled transfer.
      setImmediate(() => s.emit("data", archive.subarray(0, 700)));
    });

    const run = local.request("POST", "/local/transfer/download", {
      body: download("dl-halves6", { paths: ["/big.bin"] }),
    });
    await waitFor(
      () => disk.written.size === 0 && remote.client.streams.length > 0,
    );
    await new Promise((r) => setTimeout(r, 150));
    const cancelled = await local.request(
      "POST",
      "/transfers/dl-halves6/cancel",
    );
    expect(cancelled.status).toBe(200);

    const r = await run;
    expect(r.body.code).toBe("CANCELLED");
    expect(disk.aborted).toEqual([resolve(root, "big.bin")]);
    expect(disk.written.size).toBe(0);
    const cp = () =>
      remote.client.streams.find((_, i) =>
        /'cp'/.test(remote.client.commands[i]),
      );
    await waitFor(() => cp()?.destroyed === true);
    expect(cp()?.destroyed).toBe(true);
  });

  it("answers 404 NOT_DESKTOP without the desktop bridge", async () => {
    const local = await start();
    const r = await local.request("POST", "/local/transfer/upload", {
      body: upload("up-halves5"),
    });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("NOT_DESKTOP");
  });

  it("rejects a bad transfer id and a missing session id", async () => {
    const { local } = await pair(localFiles({}));
    const badId = await local.request("POST", "/local/transfer/upload", {
      body: upload("x"),
    });
    expect(badId.status).toBe(400);
    const noSession = await local.request("POST", "/local/transfer/upload", {
      body: upload("up-halves6", { sessionId: undefined }),
    });
    expect(noSession.status).toBe(400);
    expect(noSession.body.code).toBe("BAD_REQUEST");
  });

  it("answers 401 without an actor", async () => {
    const { local } = await pair(localFiles({}));
    const r = await local.request("POST", "/local/transfer/upload", {
      user: "",
      body: upload("up-halves7"),
    });
    expect(r.status).toBe(401);
  });

  it("keeps a local origin on the local session path", async () => {
    const { local } = await pair(localFiles({}));
    const r = await local.request("POST", "/local/transfer/upload", {
      body: upload("up-halves8", { origin: "local" }),
    });
    // No local session "s1": the old path answers, never the server.
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("NO_SESSION");
  });
});

describe("fs/du", () => {
  it("sums the content size of the paths", async () => {
    const { remote } = await pair(localFiles({}));
    remote.client.reply(/du -sb/, { stdout: "10\t/a\n5\t/b\n" });
    const r = await remote.request("POST", "/containers/s1/abc123/fs/du", {
      body: { paths: ["/a", "/b"] },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ success: true, bytes: 15 });
  });

  it("requires paths", async () => {
    const { remote } = await pair(localFiles({}));
    for (const body of [{}, { paths: [] }, { paths: [1] }]) {
      const r = await remote.request("POST", "/containers/s1/abc123/fs/du", {
        body,
      });
      expect(r.status).toBe(400);
    }
  });
});

describe("RemoteContainer", () => {
  const reply = (
    status: number,
    text: string,
    body?: AsyncIterable<Uint8Array>,
  ): FetchResult => ({
    status,
    ok: status < 400,
    headers: { get: () => null },
    body: body ?? null,
    text: async () => text,
  });
  const rc = (fetcher: PluginFetch) =>
    new RemoteContainer("s1", "abc", fetcher);
  const signal = new AbortController().signal;

  it("keeps remote ids inside the server's id rule", () => {
    const id = remoteTransferId("a".repeat(64), "d12");
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(id.endsWith("-d12")).toBe(true);
    expect(remoteTransferId("up-12345678", "u")).toBe("up-12345678-u");
  });

  it("reads 0 from an older server without fs/du", async () => {
    const container = rc(async () =>
      reply(404, '{"error":"Unknown operation"}'),
    );
    expect(await container.duBytes(["/a"], signal)).toBe(0);
  });

  it("turns a failed reply into an HttpError", async () => {
    const container = rc(async () =>
      reply(409, '{"error":"Transfer id already in use","code":"BUSY"}'),
    );
    await expect(
      container.openTar("/a", "dl-12345678-d0", signal),
    ).rejects.toMatchObject({
      status: 409,
      message: "Transfer id already in use",
      code: "BUSY",
    });
    const html = rc(async () => reply(502, "<html>bad gateway</html>"));
    await expect(
      html.openTar("/a", "dl-12345678-d0", signal),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("maps a broken or signed-out link", async () => {
    const down = rc(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      down.openTar("/a", "dl-12345678-d0", signal),
    ).rejects.toMatchObject({ status: 502, code: "REMOTE_UNAVAILABLE" });
    const out = rc(async () => {
      throw Object.assign(new Error("signed out"), { kind: "signed_out" });
    });
    await expect(
      out.openTar("/a", "dl-12345678-d0", signal),
    ).rejects.toMatchObject({ status: 401, code: "REMOTE_SIGNED_OUT" });
  });

  it("builds the transfer urls the server already serves", async () => {
    const calls: Array<{ sub: string; method?: string }> = [];
    const container = rc(async (_origin, sub, init = {}) => {
      calls.push({ sub, method: init.method });
      if (init.method === "PUT") {
        for await (const _ of init.body as AsyncIterable<unknown>) void _;
      }
      return reply(200, "{}", (async function* () {})());
    });
    await container.uploadTar(
      "/d d",
      Readable.from([Buffer.from("x")]),
      "t-1234567-u",
      signal,
    );
    await container.uploadFile(
      "/d",
      "n.txt",
      1,
      Readable.from([Buffer.from("x")]),
      {
        transferId: "t-1234567-u",
        signal,
      },
    );
    const stream = await container.openTar("/p", "t-1234567-d0", signal);
    stream.destroy();
    await container.duBytes(["/p"], signal);
    expect(calls).toEqual([
      {
        sub: "/containers/s1/abc/transfer/upload?dir=%2Fd+d&format=tar&transferId=t-1234567-u",
        method: "PUT",
      },
      {
        sub: "/containers/s1/abc/transfer/upload?dir=%2Fd&format=file&name=n.txt&size=1&overwrite=1&transferId=t-1234567-u",
        method: "PUT",
      },
      {
        sub: "/containers/s1/abc/transfer/download?path=%2Fp&kind=directory&transferId=t-1234567-d0",
        method: "GET",
      },
      { sub: "/containers/s1/abc/fs/du", method: "POST" },
    ]);
  });
});

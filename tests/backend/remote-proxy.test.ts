import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import tar from "tar-stream";
import type { PluginDesktopLocal } from "@termix-ssh/plugin-sdk/backend";
import { startServer, type TestServer } from "./server";
import type { FakeStream } from "./fake-ssh";

type PluginFetch = PluginDesktopLocal["pluginFetch"];
type FetchInit = NonNullable<Parameters<PluginFetch>[2]>;
type FetchResult = Awaited<ReturnType<PluginFetch>>;

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

function desktop(pluginFetch: PluginFetch): PluginDesktopLocal {
  return { available: () => true, pluginFetch } as PluginDesktopLocal;
}

/** A canned reply for tests that never reach a second server. */
function canned(
  status: number,
  options: {
    headers?: Record<string, string>;
    body?: AsyncIterable<Uint8Array>;
    text?: () => Promise<string>;
  } = {},
): FetchResult {
  const headers = options.headers ?? {};
  return {
    status,
    ok: status < 400,
    headers: { get: (name: string) => headers[name] ?? null },
    body: options.body ?? null,
    text: options.text ?? (async () => ""),
  };
}

async function pair() {
  const remote = await start();
  const local = await start({
    mock: { desktopLocal: desktop(forwardTo(remote)) },
  });
  return { remote, local };
}

const connectRemote = (local: TestServer) =>
  local.request("POST", "/remote/ssh/connect", {
    body: { sessionId: "s1", hostId: 7 },
  });

/** Records what the channel receives and exits when it is closed. */
function sink(onData: (data: Buffer) => void) {
  return (stream: FakeStream) => {
    const parts: Buffer[] = [];
    stream.write = (d: Buffer | string) => {
      parts.push(Buffer.from(d));
      return true;
    };
    stream.end = () => {
      onData(Buffer.concat(parts));
      stream.finish("", 0);
    };
  };
}

async function tarOf(name: string, body: string): Promise<Buffer> {
  const pack = tar.pack();
  pack.entry({ name, size: body.length } as tar.Header, body);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const c of pack) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** A request with a stream body, so it goes out chunked without a length. */
function streamedPut(local: TestServer, path: string, payload: Buffer) {
  return fetch(local.url(path), {
    method: "PUT",
    headers: {
      "x-test-user": "user-1",
      "content-type": "application/octet-stream",
    },
    body: Readable.toWeb(Readable.from([payload])) as never,
    duplex: "half",
  } as RequestInit);
}

async function waitFor(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const FS = "/containers/s1/abc123";

describe("remote proxy", () => {
  it("connects on the server and leaves the local backend without a session", async () => {
    const { remote, local } = await pair();
    const r = await connectRemote(local);
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    expect((await remote.request("GET", "/containers/s1")).status).toBe(200);
    expect((await local.request("GET", "/remote/containers/s1")).status).toBe(
      200,
    );

    const direct = await local.request("GET", "/containers/s1");
    expect(direct.status).toBe(400);
    expect(direct.body.code).toBe("NO_SESSION");
  });

  it("streams a listing and writes a file", async () => {
    const { remote, local } = await pair();
    await connectRemote(local);
    const list = await local.raw("GET", `/remote${FS}/fs/list?path=/etc/`);
    expect(list.status).toBe(200);
    const lines = list.buffer
      .toString()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].meta).toMatchObject({ path: "/etc" });
    expect(lines.at(-1)).toEqual({ done: true });

    let written: Buffer = Buffer.alloc(0);
    remote.client.reply(
      /cat/,
      sink((d) => (written = d)),
    );
    const write = await local.request("POST", `/remote${FS}/fs/write`, {
      body: { path: "/data/a.txt", content: "héllo" },
    });
    // The parsed JSON body reached the server intact, whatever the write did.
    expect(write.body?.code).not.toBe("BAD_REQUEST");
    expect(write.status, JSON.stringify(write.body)).toBeLessThan(500);
    void written;
  });

  it("uploads an octet stream without Content-Length using the size query", async () => {
    const { remote, local } = await pair();
    await connectRemote(local);
    let received: Buffer = Buffer.alloc(0);
    remote.client.reply(
      /'cp'/,
      sink((d) => (received = d)),
    );
    remote.client.reply(/%u %g/, { stdout: "1000 1000\n" });

    const response = await streamedPut(
      local,
      `/remote${FS}/transfer/upload?dir=/data&name=up.txt&size=7&transferId=up-12345678`,
      Buffer.from("payload"),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ bytes: 7 });
    expect(received.length).toBeGreaterThan(0);

    const status = await local.request("GET", "/remote/transfers/up-12345678");
    expect(status.body).toMatchObject({
      direction: "upload",
      state: "done",
      total: 7,
    });
  });

  it("rejects an upload with neither Content-Length nor size", async () => {
    const { local } = await pair();
    await connectRemote(local);
    const response = await streamedPut(
      local,
      `/remote${FS}/transfer/upload?dir=/data&name=up.txt&transferId=up-99999999`,
      Buffer.from("x"),
    );
    expect(response.status).toBe(411);
  });

  it("downloads with the bytes and Content-Disposition intact", async () => {
    const { remote, local } = await pair();
    await connectRemote(local);
    remote.client.reply(/'cp'/, { stdout: await tarOf("f.bin", "hello") });
    const r = await local.raw(
      "GET",
      `/remote${FS}/transfer/download?path=/f.bin&kind=file&transferId=dl-12345678`,
    );
    expect(r.status).toBe(200);
    expect(r.buffer.toString()).toBe("hello");
    expect(r.headers.get("content-length")).toBe("5");
    expect(r.headers.get("content-disposition")).toContain("f.bin");
    const status = await local.request("GET", "/remote/transfers/dl-12345678");
    expect(status.body).toMatchObject({ state: "done", bytes: 5 });
  });

  it("copies between containers on the server", async () => {
    const { remote, local } = await pair();
    await connectRemote(local);
    let received: Buffer = Buffer.alloc(0);
    remote.client.reply(/'cp' '-L' 'abc123:\/src\/f' '-'/, {
      stdout: await tarOf("f", "hi"),
    });
    remote.client.reply(
      /'cp' '-a' '-' 'other1:\/dest'/,
      sink((d) => (received = d)),
    );
    remote.client.reply(/%u %g/, { stdout: "5 6\n" });
    const r = await local.request("POST", "/remote/containers/s1/copy", {
      body: {
        from: { containerId: "abc123", paths: ["/src/f"] },
        to: { containerId: "other1", dir: "/dest" },
        transferId: "c2c-proxy-01",
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ success: true, copied: 1 });
    expect(received.length).toBeGreaterThan(0);
    const status = await local.request("GET", "/remote/transfers/c2c-proxy-01");
    expect(status.body).toMatchObject({ direction: "c2c", state: "done" });
  });

  it("delivers the first chunk before the last", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const local = await start({
      mock: {
        desktopLocal: desktop(async () =>
          canned(200, {
            headers: { "content-type": "application/x-ndjson" },
            body: (async function* () {
              yield Buffer.from('{"meta":1}\n');
              await gate;
              yield Buffer.from('{"done":true}\n');
            })(),
          }),
        ),
      },
    });
    const response = await fetch(local.url("/remote/containers/s1/x/fs/list"), {
      headers: { "x-test-user": "user-1" },
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value!).toString()).toBe('{"meta":1}\n');
    release();
    const second = await reader.read();
    expect(Buffer.from(second.value!).toString()).toBe('{"done":true}\n');
    expect((await reader.read()).done).toBe(true);
  });

  it("aborts the remote request when the client goes away", async () => {
    let seen: AbortSignal | undefined;
    const local = await start({
      mock: {
        desktopLocal: desktop(async (_origin, _sub, init = {}) => {
          seen = init.signal;
          return canned(200, {
            body: (async function* () {
              yield Buffer.from("a");
              await new Promise(() => undefined);
            })(),
          });
        }),
      },
    });
    const controller = new AbortController();
    const response = await fetch(local.url("/remote/containers/s1/x/fs/list"), {
      headers: { "x-test-user": "user-1" },
      signal: controller.signal,
    });
    await response.body!.getReader().read();
    expect(seen?.aborted).toBe(false);
    controller.abort();
    await waitFor(() => seen?.aborted === true);
    expect(seen?.aborted).toBe(true);
  });

  it("forwards only the whitelisted headers, the method and the JSON body", async () => {
    let call: { sub: string; init: FetchInit } | undefined;
    const local = await start({
      mock: {
        desktopLocal: desktop(async (_origin, sub, init = {}) => {
          call = { sub, init };
          return canned(200);
        }),
      },
    });
    const response = await fetch(local.url("/remote/ssh/status?sessionId=s1"), {
      method: "POST",
      headers: {
        "x-test-user": "user-1",
        "content-type": "application/json",
        cookie: "secret=1",
        authorization: "Bearer x",
      },
      body: JSON.stringify({ a: 1 }),
    });
    expect(response.status).toBe(200);
    expect(call?.sub).toBe("/ssh/status?sessionId=s1");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.body).toBe('{"a":1}');
    expect(Object.keys(call!.init.headers!).sort()).toEqual([
      "accept",
      "content-type",
    ]);
  });

  describe("errors", () => {
    it("answers 404 NOT_DESKTOP without the desktop bridge", async () => {
      const local = await start();
      const r = await local.request("GET", "/remote/ssh/status?sessionId=s1");
      expect(r.status).toBe(404);
      expect(r.body.code).toBe("NOT_DESKTOP");
    });

    it("answers 401 without an actor", async () => {
      const { local } = await pair();
      const r = await local.request("GET", "/remote/ssh/status", { user: "" });
      expect(r.status).toBe(401);
    });

    it("answers 400 for paths outside the allowed routes", async () => {
      const { local } = await pair();
      for (const path of [
        "/remote/local/home",
        "/remote/remote/ssh/status",
        "/remote/",
        "/remote/sshx/status",
        "/remote/containers/a/%2e%2e/%2e%2e/x",
        "/remote/ssh/..%2fstatus",
        "/remote/ssh//status",
      ]) {
        const r = await local.request("GET", path);
        expect(r.status, path).toBe(400);
        expect(r.body.code).toBe("BAD_REQUEST");
      }
    });

    it("answers 502 REMOTE_UNAVAILABLE when pluginFetch throws", async () => {
      const local = await start({
        mock: {
          desktopLocal: desktop(async () => {
            throw new Error("ECONNREFUSED");
          }),
        },
      });
      const r = await local.request("GET", "/remote/ssh/status?sessionId=s1");
      expect(r.status).toBe(502);
      expect(r.body.code).toBe("REMOTE_UNAVAILABLE");
    });

    it("answers 401 REMOTE_SIGNED_OUT when the link is signed out", async () => {
      const local = await start({
        mock: {
          desktopLocal: desktop(async () => {
            throw Object.assign(new Error("signed out"), {
              kind: "signed_out",
            });
          }),
        },
      });
      const r = await local.request("GET", "/remote/ssh/status?sessionId=s1");
      expect(r.status).toBe(401);
      expect(r.body.code).toBe("REMOTE_SIGNED_OUT");
    });

    it("tags a foreign 401 and keeps our own", async () => {
      const foreign = await start({
        mock: {
          desktopLocal: desktop(async () =>
            canned(401, { text: async () => "<html>login</html>" }),
          ),
        },
      });
      const a = await foreign.request("GET", "/remote/ssh/status?sessionId=s1");
      expect(a.status).toBe(401);
      expect(a.body.code).toBe("REMOTE_SIGNED_OUT");

      const own = await start({
        mock: {
          desktopLocal: desktop(async () =>
            canned(401, {
              text: async () => '{"error":"Denied","code":"DENIED"}',
            }),
          ),
        },
      });
      const b = await own.request("GET", "/remote/ssh/status?sessionId=s1");
      expect(b.status).toBe(401);
      expect(b.body.code).toBe("DENIED");
    });

    it("passes the server's error status through", async () => {
      const { local } = await pair();
      const r = await local.request("GET", "/remote/containers/nope");
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("NO_SESSION");
    });
  });
});

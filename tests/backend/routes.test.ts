import { afterEach, describe, expect, it } from "vitest";
import tar from "tar-stream";
import { nul, startServer, type TestServer } from "./server";
import { FakeClient, FakeStream } from "./fake-ssh";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function connect(s: TestServer, sessionId = "s1") {
  return s.request("POST", "/ssh/connect", { body: { sessionId, hostId: 7 } });
}

const FS = "/containers/s1/abc123";

describe("routes", () => {
  it("refuses every route without the use permission", async () => {
    server = await startServer({ permissions: [] });
    const calls: Array<[string, string]> = [
      ["POST", "/ssh/connect"],
      ["POST", "/ssh/disconnect"],
      ["GET", "/ssh/status?sessionId=s1"],
      ["GET", "/containers/s1"],
      ["GET", `${FS}/capabilities`],
      ["GET", `${FS}/fs/list?path=/`],
      ["POST", `${FS}/fs/mkdir`],
      ["GET", `${FS}/transfer/download?path=/a`],
      ["PUT", `${FS}/transfer/upload?dir=/`],
      ["GET", "/transfers/abcdefgh"],
    ];
    for (const [method, path] of calls) {
      const r = await server.request(method, path, { body: {} });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
  });

  it("connects, detects the runtime and reports status", async () => {
    server = await startServer();
    const r = await connect(server);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, runtime: "docker" });
    const status = await server.request("GET", "/ssh/status?sessionId=s1");
    expect(status.body).toMatchObject({ connected: true, runtime: "docker" });
    const other = await server.request("GET", "/ssh/status?sessionId=s1", {
      user: "user-2",
    });
    expect(other.body.connected).toBe(false);
  });

  it("reports the engine version", async () => {
    server = await startServer();
    server.client.reply(/version --format/, { stdout: "29.9.0\n" });
    const r = await connect(server);
    expect(r.body).toMatchObject({
      runtime: "docker",
      runtimeVersion: "29.9.0",
    });
    const status = await server.request("GET", "/ssh/status?sessionId=s1");
    expect(status.body.runtimeVersion).toBe("29.9.0");
  });

  it("fails when the host has no container runtime", async () => {
    server = await startServer({
      client: new FakeClient([[/command -v/, { stdout: "" }]]),
    });
    const r = await connect(server);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("NO_RUNTIME");
    const status = await server.request("GET", "/ssh/status?sessionId=s1");
    expect(status.body.connected).toBe(false);
  });

  it("answers 400 for sessions that do not exist", async () => {
    server = await startServer();
    const r = await server.request("GET", "/containers/nope");
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("NO_SESSION");
  });

  it("lists containers", async () => {
    server = await startServer();
    await connect(server);
    const r = await server.request("GET", "/containers/s1");
    expect(r.status).toBe(200);
    expect(r.body.containers[0]).toMatchObject({
      name: "web",
      state: "running",
    });
  });

  it("rejects invalid container ids before running anything", async () => {
    server = await startServer();
    await connect(server);
    const before = server.client.commands.length;
    const r = await server.request(
      "GET",
      "/containers/s1/bad%3Bid/capabilities",
    );
    expect(r.status).toBe(400);
    expect(server.client.commands.length).toBe(before);
  });

  it("probes capabilities", async () => {
    server = await startServer();
    await connect(server);
    const r = await server.request("GET", `${FS}/capabilities`);
    expect(r.body).toMatchObject({
      exec: true,
      findPrintf: true,
      running: true,
    });
  });

  it("streams a listing as NDJSON", async () => {
    server = await startServer();
    await connect(server);
    const r = await server.raw("GET", `${FS}/fs/list?path=/etc/`);
    expect(r.status).toBe(200);
    const lines = r.buffer
      .toString()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].meta).toMatchObject({
      path: "/etc",
      tier: "find",
      total: 1,
    });
    expect(lines[1].entries[0]).toMatchObject({ name: "a.txt", size: 3 });
    expect(lines.at(-1)).toEqual({ done: true });
  });

  it("hides temporary upload files from listings", async () => {
    server = await startServer();
    await connect(server);
    server.client.reply(/-mindepth 1/, {
      stdout:
        nul("a.txt", "f", "3", "100.0", "644", "root", "root", "", "f") +
        nul(
          ".cf-part-up-x-b.txt",
          "f",
          "1",
          "100.0",
          "644",
          "root",
          "root",
          "",
          "f",
        ),
    });
    const r = await server.raw("GET", `${FS}/fs/list?path=/tmp`);
    const lines = r.buffer
      .toString()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].meta.total).toBe(1);
    expect(lines[1].entries.map((e: { name: string }) => e.name)).toEqual([
      "a.txt",
    ]);
  });

  it("returns 404 for unknown containers", async () => {
    server = await startServer();
    await connect(server);
    server.client.reply(/'inspect'/, { code: 1, stderr: "No such object" });
    const r = await server.request("GET", `${FS}/fs/list?path=/`);
    expect(r.status).toBe(404);
  });

  it("runs operations and clears cached listings", async () => {
    server = await startServer();
    await connect(server);
    const mk = await server.request("POST", `${FS}/fs/mkdir`, {
      body: { path: "/data/new dir" },
    });
    expect(mk.status).toBe(200);
    expect(server.client.commands.at(-1)).toContain("'/data/new dir'");

    server.client.reply(/\bmkdir\b/, { code: 17 });
    const dup = await server.request("POST", `${FS}/fs/mkdir`, {
      body: { path: "/data" },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("EXISTS");

    const bad = await server.request("POST", `${FS}/fs/explode`, { body: {} });
    expect(bad.status).toBe(404);
    const root = await server.request("POST", `${FS}/fs/delete`, {
      body: { paths: ["/"] },
    });
    expect(root.status).toBe(400);
  });

  it("creates and retargets symbolic links", async () => {
    server = await startServer();
    await connect(server);
    const mk = await server.request("POST", `${FS}/fs/symlink`, {
      body: { path: "/data/l ink", target: "../rel target" },
    });
    expect(mk.status).toBe(200);
    expect(server.client.commands.at(-1)).toContain(
      "'../rel target' '/data/l ink' '0'",
    );

    const forced = await server.request("POST", `${FS}/fs/symlink`, {
      body: { path: "/data/l", target: "/etc", force: true },
    });
    expect(forced.status).toBe(200);
    const cmd = server.client.commands.at(-1) ?? "";
    expect(cmd).toContain("ln -sfn");
    expect(cmd).toContain("'/etc' '/data/l' '1'");

    for (const body of [
      { path: "/a", target: "" },
      { path: "/a", target: "x\0y" },
      { path: "a", target: "x" },
      { path: "/", target: "x" },
    ]) {
      const bad = await server.request("POST", `${FS}/fs/symlink`, { body });
      expect(bad.status).toBe(400);
    }

    server.client.reply(/ln -s/, { code: 17 });
    const dup = await server.request("POST", `${FS}/fs/symlink`, {
      body: { path: "/data/f", target: "x" },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("EXISTS");
  });

  it("downloads a file from the cp stream", async () => {
    server = await startServer();
    await connect(server);
    const pack = tar.pack();
    pack.entry({ name: "f.bin", size: 5 } as tar.Header, "hello");
    pack.finalize();
    const chunks: Buffer[] = [];
    for await (const c of pack) chunks.push(c as Buffer);
    server.client.reply(/'cp'/, { stdout: Buffer.concat(chunks) });

    const r = await server.raw(
      "GET",
      `${FS}/transfer/download?path=/f.bin&kind=file&transferId=dl-12345678`,
    );
    expect(r.status).toBe(200);
    expect(r.buffer.toString()).toBe("hello");
    expect(r.headers.get("content-length")).toBe("5");
    const status = await server.request("GET", "/transfers/dl-12345678");
    expect(status.body).toMatchObject({ state: "done", bytes: 5 });
  });

  it("uploads a file as a tar via a temporary name", async () => {
    server = await startServer();
    await connect(server);
    let received = Buffer.alloc(0) as Buffer;
    server.client.reply(/'cp'/, (stream: FakeStream) => {
      const parts: Buffer[] = [];
      stream.write = (d: Buffer | string) => {
        parts.push(Buffer.from(d));
        return true;
      };
      stream.end = () => {
        received = Buffer.concat(parts);
        stream.finish("", 0);
      };
    });
    // owner lookup
    server.client.reply(/%u %g/, { stdout: "1000 1000\n" });

    const r = await server.raw(
      "PUT",
      `${FS}/transfer/upload?dir=/data&name=up.txt&transferId=up-12345678`,
      { body: Buffer.from("payload") },
    );
    expect(r.status, r.buffer.toString()).toBe(200);
    expect(JSON.parse(r.buffer.toString())).toMatchObject({ bytes: 7 });

    const names: string[] = [];
    const ex = tar.extract();
    ex.on("entry", (h, s, next) => {
      names.push(`${h.name}:${h.uid}`);
      s.resume();
      s.on("end", next);
    });
    ex.end(received);
    await new Promise<void>((resolve) => ex.on("finish", () => resolve()));
    expect(names).toEqual([".cf-part-up-12345-up.txt:1000"]);
    const mv = server.client.commands.find((c) => c.includes("mv -f"));
    expect(mv).toContain("'/data/.cf-part-up-12345-up.txt' '/data/up.txt'");
  });

  it("refuses an upload that would overwrite", async () => {
    server = await startServer();
    await connect(server);
    server.client.reply(/\[ -e "\$1" \]/, { code: 17 });
    server.client.reply(/%u %g/, { stdout: "0 0\n" });
    const r = await server.raw(
      "PUT",
      `${FS}/transfer/upload?dir=/data&name=up.txt&transferId=up-87654321`,
      { body: Buffer.from("x") },
    );
    expect(r.status).toBe(409);
  });

  it("closes the session on disconnect", async () => {
    server = await startServer();
    await connect(server);
    await server.request("POST", "/ssh/disconnect", {
      body: { sessionId: "s1" },
    });
    const r = await server.request("GET", "/containers/s1");
    expect(r.status).toBe(400);
  });
});

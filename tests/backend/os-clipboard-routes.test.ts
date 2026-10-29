import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginDesktopLocal } from "@termix-ssh/plugin-sdk/backend";
import { startServer, type TestServer } from "./server";

const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/**
 * A local pty that plays PowerShell: it echoes the typed line, decodes the
 * -EncodedCommand script, takes its nonce and answers like `reply` says.
 */
function fakeLocal(
  platform: string,
  reply: (nonce: string, script: string) => string[] | "silent" | "exit",
  opts: { spawnFails?: string } = {},
) {
  const scripts: string[] = [];
  const local = {
    available: () => true,
    info: async () => ({ platform }),
    pty: {
      spawn: async () => {
        if (opts.spawnFails) throw new Error(opts.spawnFails);
        const data: Array<(d: string) => void> = [];
        const exit: Array<(c: number) => void> = [];
        return {
          pid: 1,
          shell: "powershell.exe",
          resize: () => undefined,
          kill: () => undefined,
          onData: (h: (d: string) => void) => {
            data.push(h);
            return () => undefined;
          },
          onExit: (h: (c: number) => void) => {
            exit.push(h);
            return () => undefined;
          },
          write: (line: string) => {
            const encoded = line.split(" -EncodedCommand ")[1]?.trim();
            const script = Buffer.from(encoded, "base64").toString("utf16le");
            scripts.push(script);
            const nonce = /'CFPS'\+'END'\+'([A-Za-z0-9]+)'/.exec(script)![1];
            const out = reply(nonce, script);
            setTimeout(() => {
              for (const h of data) h(line);
              if (out === "exit") for (const h of exit) h(1);
              else if (out !== "silent")
                for (const l of out) for (const h of data) h(`${l}\r\n`);
            }, 1);
          },
        };
      },
    },
  } as unknown as PluginDesktopLocal;
  return { local, scripts };
}

async function start(local: PluginDesktopLocal) {
  const s = await startServer({ mock: { desktopLocal: local } });
  servers.push(s);
  return s;
}

const list = (nonce: string, entries: string) => [
  `CFPSOUT${nonce}:${b64(entries)}`,
  `CFPSEND${nonce}`,
];

describe("POST /local/clipboard/read", () => {
  it("returns the files and folders Explorer copied", async () => {
    const { local, scripts } = fakeLocal("win32", (n) =>
      list(n, "DC:\\Users\\me\\Папка\nFC:\\Users\\me\\файл 1.txt"),
    );
    const s = await start(local);
    const res = await s.request("POST", "/local/clipboard/read", { body: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      files: [
        { path: "C:\\Users\\me\\Папка", isDirectory: true },
        { path: "C:\\Users\\me\\файл 1.txt", isDirectory: false },
      ],
      own: false,
    });
    expect(scripts[0]).toContain("Get-Clipboard -Format FileDropList");
  });

  it("is empty when the clipboard holds no files", async () => {
    const { local } = fakeLocal("win32", (n) => list(n, ""));
    const s = await start(local);
    const res = await s.request("POST", "/local/clipboard/read", { body: {} });
    expect(res.body).toEqual({ success: true, files: [], own: false });
  });

  it("marks the plugin's own temp copy", async () => {
    let dir = "";
    const { local } = fakeLocal("win32", (n) =>
      list(n, `F${join(dir, "a.txt")}`),
    );
    const s = await start(local);
    const prepared = await s.request("POST", "/local/clipboard/prepare", {
      body: {},
    });
    dir = prepared.body.dir;
    const res = await s.request("POST", "/local/clipboard/read", { body: {} });
    expect(res.body.own).toBe(true);
    await s.request("POST", "/local/clipboard/clear", { body: {} });
  });

  it("explains a PowerShell error with its reason", async () => {
    const { local } = fakeLocal("win32", (n) => [
      `CFPSERR${n}:${b64("Буфер обмена занят")}`,
    ]);
    const s = await start(local);
    const res = await s.request("POST", "/local/clipboard/read", { body: {} });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: false,
      code: "CLIP_SCRIPT",
      error: "PowerShell reported an error: Буфер обмена занят",
    });
  });

  it("reports a PowerShell that cannot start", async () => {
    const { local } = fakeLocal("win32", () => [], {
      spawnFails: "spawn powershell.exe ENOENT",
    });
    const s = await start(local);
    const res = await s.request("POST", "/local/clipboard/read", { body: {} });
    expect(res.body.code).toBe("CLIP_SPAWN");
    expect(res.body.error).toContain("ENOENT");
  });

  it("reports a PowerShell that closes early", async () => {
    const { local } = fakeLocal("win32", () => "exit");
    const s = await start(local);
    const res = await s.request("POST", "/local/clipboard/read", { body: {} });
    expect(res.body.code).toBe("CLIP_EXIT");
  });

  it("refuses other systems with UNSUPPORTED", async () => {
    const { local, scripts } = fakeLocal("darwin", () => []);
    const s = await start(local);
    const res = await s.request("POST", "/local/clipboard/read", { body: {} });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe("UNSUPPORTED");
    expect(scripts).toEqual([]);
  });

  it("answers NOT_DESKTOP outside the desktop app", async () => {
    const s = await startServer();
    servers.push(s);
    const res = await s.request("POST", "/local/clipboard/read", { body: {} });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_DESKTOP");
  });
});

describe("POST /local/clipboard/set", () => {
  it("puts the temp copy on the clipboard in one script", async () => {
    const { local, scripts } = fakeLocal("win32", (n) => [`CFPSEND${n}`]);
    const s = await start(local);
    const { body } = await s.request("POST", "/local/clipboard/prepare", {
      body: {},
    });
    dirs.push(body.dir);
    writeFileSync(join(body.dir, "a.txt"), "1");
    writeFileSync(join(body.dir, "b.txt"), "2");
    const res = await s.request("POST", "/local/clipboard/set", {
      body: { dir: body.dir, names: ["a.txt", "b.txt"] },
    });
    expect(res.body).toEqual({ success: true });
    expect(scripts[0]).toContain("Set-Clipboard -LiteralPath $p");
    expect(scripts[0]).not.toContain("ConvertFrom-Json");
    expect(scripts[0]).not.toContain("a.txt");
  });

  it("shows why PowerShell failed", async () => {
    const { local } = fakeLocal("win32", (n) => [
      `CFPSERR${n}:${b64("Нет доступа к буферу обмена")}`,
    ]);
    const s = await start(local);
    const { body } = await s.request("POST", "/local/clipboard/prepare", {
      body: {},
    });
    writeFileSync(join(body.dir, "a.txt"), "1");
    const res = await s.request("POST", "/local/clipboard/set", {
      body: { dir: body.dir, names: ["a.txt"] },
    });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe("CLIP_SCRIPT");
    expect(res.body.error).toContain("Нет доступа к буферу обмена");
  });

  it("refuses a directory that is not the current copy", async () => {
    const { local, scripts } = fakeLocal("win32", (n) => [`CFPSEND${n}`]);
    const s = await start(local);
    const other = mkdtempSync(join(tmpdir(), "cf-other-"));
    dirs.push(other);
    const res = await s.request("POST", "/local/clipboard/set", {
      body: { dir: other, names: ["a.txt"] },
    });
    expect(res.body.success).toBe(false);
    expect(scripts).toEqual([]);
  });
});

describe("POST /local/clipboard/set-paths", () => {
  it("lists real local paths on the clipboard and drops the temp copy", async () => {
    const { local, scripts } = fakeLocal("win32", (n) => [`CFPSEND${n}`]);
    const s = await start(local);
    const { body } = await s.request("POST", "/local/clipboard/prepare", {
      body: {},
    });
    dirs.push(body.dir);
    const real = mkdtempSync(join(tmpdir(), "cf-real-"));
    dirs.push(real);
    const file = join(real, "my file.txt");
    writeFileSync(file, "1");
    const res = await s.request("POST", "/local/clipboard/set-paths", {
      body: { paths: [file, real] },
    });
    expect(res.body).toEqual({ success: true });
    expect(scripts[0]).toContain("Set-Clipboard -LiteralPath $p");
    expect(scripts[0]).not.toContain("my file.txt");
    // The old container copy is no longer the clipboard.
    const after = await s.request("POST", "/local/clipboard/set", {
      body: { dir: body.dir, names: [] },
    });
    expect(after.body.success).toBe(false);
  });

  it("refuses relative, missing and empty lists without running PowerShell", async () => {
    const { local, scripts } = fakeLocal("win32", (n) => [`CFPSEND${n}`]);
    const s = await start(local);
    for (const paths of [[], ["relative.txt"], [""], [5], "x"]) {
      const res = await s.request("POST", "/local/clipboard/set-paths", {
        body: { paths },
      });
      expect(res.body.success).toBe(false);
    }
    const gone = await s.request("POST", "/local/clipboard/set-paths", {
      body: { paths: [join(tmpdir(), "cf-does-not-exist-123")] },
    });
    expect(gone.body.success).toBe(false);
    expect(scripts).toEqual([]);
  });

  it("is Windows only", async () => {
    const { local } = fakeLocal("linux", (n) => [`CFPSEND${n}`]);
    const s = await start(local);
    const res = await s.request("POST", "/local/clipboard/set-paths", {
      body: { paths: [tmpdir()] },
    });
    expect(res.body.code).toBe("UNSUPPORTED");
  });
});

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import tar from "tar-stream";
import type { PluginDesktopLocal } from "@termix-ssh/plugin-sdk/backend";
import type { ListTarget } from "../../src/backend/fs-list";
import {
  downloadToLocal,
  localTarget,
  normalizeLocalDir,
} from "../../src/backend/local-transfer";
import { TransferRegistry } from "../../src/backend/transfers";
import {
  hasPaneDrag,
  startPaneDrag,
} from "../../src/frontend/workspace/paneDrag";
import { runtimeLabel } from "../../src/frontend/runtimeLabel";
import { FakeClient } from "./fake-ssh";

const caps = {
  running: true,
  exec: true,
  findPrintf: true,
  statC: true,
  tools: ["tar"],
};
const target = (client: FakeClient): ListTarget => ({
  client: client.asClient(),
  runtime: "docker",
  containerId: "abc",
  capabilities: caps,
});

async function tarOf(
  entries: { header: Partial<tar.Header> & { name: string }; body?: string }[],
): Promise<Buffer> {
  const pack = tar.pack();
  for (const { header, body } of entries)
    pack.entry(header as tar.Header, body);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const c of pack) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function fakeDisk(options: { failOpen?: boolean } = {}) {
  const written = new Map<string, string>();
  const ensured: { dir: string; root?: string }[] = [];
  const opened: { destPath: string; rootPath: string }[] = [];
  const fs = {
    ensureDir: async (dir: string, root?: string) => {
      // Like the desktop: with a root the folder must lie strictly inside it.
      if (root !== undefined && dir.toLowerCase() === root.toLowerCase()) {
        throw new Error(
          `"${dir.split(/[\\/]/).pop()}" would be written outside the selected folder`,
        );
      }
      ensured.push({ dir, root });
      return dir;
    },
    openDownload: async (o: { destPath: string; rootPath: string }) => {
      if (options.failOpen) throw new Error("EACCES: permission denied");
      opened.push(o);
      const chunks: Buffer[] = [];
      const stream = new Writable({
        write(chunk, _e, cb) {
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
        abort: async () => {},
      };
    },
  } as unknown as PluginDesktopLocal["fs"];
  return { fs, written, ensured, opened };
}

async function download(
  localDir: string,
  entries: Parameters<typeof tarOf>[0],
  disk = fakeDisk(),
  id = "dl-win-0001",
) {
  const archive = await tarOf(entries);
  const client = new FakeClient([
    [/du -sb/, { stdout: `${archive.length}\t/x\n` }],
    [/'cp'/, { stdout: archive }],
  ]);
  const transfer = new TransferRegistry().start(id, "u", "local-down", 0);
  const run = () =>
    downloadToLocal(target(client), disk.fs, transfer, {
      paths: ["/x"],
      localDir,
    });
  return { run, disk };
}

describe("normalizeLocalDir", () => {
  it("keeps Windows paths in win32 form on any OS", () => {
    expect(normalizeLocalDir("C:\\Users\\me\\Downloads").path).toBe(
      "C:\\Users\\me\\Downloads",
    );
    expect(normalizeLocalDir("C:/Users/me").path).toBe("C:\\Users\\me");
    expect(normalizeLocalDir("/C:/Users/me").path).toBe("C:\\Users\\me");
    expect(normalizeLocalDir("\\\\srv\\share\\dir").path).toBe(
      "\\\\srv\\share\\dir",
    );
  });

  it("treats //srv/x as UNC only on Windows", () => {
    const got = normalizeLocalDir("//srv/x/d").path;
    expect(got).toBe(
      process.platform === "win32" ? "\\\\srv\\x\\d" : "/srv/x/d",
    );
  });

  it("keeps POSIX paths and refuses relative ones", () => {
    expect(normalizeLocalDir("/home/me/dl/").path).toBe("/home/me/dl");
    expect(() => normalizeLocalDir("Downloads")).toThrow(/absolute/);
    expect(() => normalizeLocalDir("./x")).toThrow(/absolute/);
  });

  it("joins archive entries with the destination's separator", () => {
    expect(localTarget("C:\\Users\\me", "proj/sub/a.txt")).toBe(
      "C:\\Users\\me\\proj\\sub\\a.txt",
    );
    expect(localTarget("C:/", "a.txt")).toBe("C:\\a.txt");
    expect(localTarget("/home/me", "proj/a.txt")).toBe("/home/me/proj/a.txt");
    expect(() => localTarget("C:\\Users\\me", "..\\..\\evil")).toThrow(
      /Unsafe/,
    );
    expect(() => localTarget("C:\\Users\\me", "../../evil")).toThrow(/Unsafe/);
    expect(() => localTarget("C:\\Users\\me", "D:/evil")).toThrow(/Unsafe/);
  });
});

describe("downloadToLocal destination", () => {
  it("writes under a Windows destination folder with absolute paths", async () => {
    const { run, disk } = await download("C:/Users/me/Downloads", [
      { header: { name: "proj/", type: "directory" } },
      { header: { name: "proj/a.txt", size: 3 }, body: "abc" },
    ]);
    const result = await run();
    expect(result).toMatchObject({ files: 1, dirs: 1, bytesWritten: 3 });
    expect([...disk.written.keys()]).toEqual([
      "C:\\Users\\me\\Downloads\\proj\\a.txt",
    ]);
    expect(disk.opened[0].rootPath).toBe("C:\\Users\\me\\Downloads");
    for (const e of disk.ensured)
      expect(e.root).toBe("C:\\Users\\me\\Downloads");
  });

  it("places a lone file directly in the folder", async () => {
    const { run, disk } = await download("D:\\data", [
      { header: { name: "x", size: 2 }, body: "hi" },
    ]);
    await run();
    expect(disk.written.get("D:\\data\\x")).toBe("hi");
  });

  it("copies a lone file into an ordinary Windows folder with dashes", async () => {
    const dest = "D:\\Downloads\\hermes-suite-fixed-update";
    const { run, disk } = await download(
      dest,
      [{ header: { name: "run.sh", size: 2 }, body: "hi" }],
      fakeDisk(),
      "dl-hermes-01",
    );
    await expect(run()).resolves.toMatchObject({ files: 1 });
    expect(disk.written.get(`${dest}\\run.sh`)).toBe("hi");
    // the chosen folder itself is never "inside" itself
    expect(disk.ensured.find((e) => e.dir === dest)?.root).toBeUndefined();
  });

  it("copies a folder named like the destination and keeps traversal blocked", async () => {
    const dest = "D:\\Downloads\\hermes-suite-fixed-update";
    const ok = await download(
      dest,
      [
        { header: { name: "hermes-suite-fixed-update/", type: "directory" } },
        {
          header: { name: "hermes-suite-fixed-update/a.txt", size: 1 },
          body: "a",
        },
      ],
      fakeDisk(),
      "dl-hermes-02",
    );
    await expect(ok.run()).resolves.toMatchObject({ files: 1, dirs: 1 });
    expect([...ok.disk.written.keys()]).toEqual([
      `${dest}\\hermes-suite-fixed-update\\a.txt`,
    ]);
    const evil = await download(
      dest,
      [{ header: { name: "../escape.txt", size: 1 }, body: "x" }],
      fakeDisk(),
      "dl-hermes-03",
    );
    await expect(evil.run()).rejects.toBeTruthy();
    expect(evil.disk.written.size).toBe(0);
  });

  it("refuses a relative destination and writes nothing", async () => {
    const { run, disk } = await download("Downloads", [
      { header: { name: "x", size: 2 }, body: "hi" },
    ]);
    await expect(run()).rejects.toMatchObject({ status: 400 });
    expect(disk.written.size).toBe(0);
  });
});

describe("downloadToLocal never reports an empty success", () => {
  it("fails with the disk's reason when every file is refused", async () => {
    const { run } = await download(
      "C:\\Users\\me",
      [{ header: { name: "x", size: 2 }, body: "hi" }],
      fakeDisk({ failOpen: true }),
      "dl-fail-0002",
    );
    await expect(run()).rejects.toMatchObject({
      code: "NOTHING_WRITTEN",
      message: expect.stringContaining("EACCES"),
    });
  });

  it("fails when the archive holds only skipped entries", async () => {
    const { run } = await download(
      "C:\\Users\\me",
      [{ header: { name: "ln", type: "symlink", linkname: "t" } }],
      fakeDisk(),
      "dl-links-004",
    );
    await expect(run()).rejects.toMatchObject({ code: "NOTHING_WRITTEN" });
  });

  it("keeps partial success and lists what was skipped", async () => {
    const { run } = await download(
      "/home/me",
      [
        { header: { name: "a", size: 1 }, body: "a" },
        { header: { name: "ln", type: "symlink", linkname: "a" } },
      ],
      fakeDisk(),
      "dl-part-0005",
    );
    expect(await run()).toMatchObject({ files: 1, skipped: ["ln"] });
  });
});

describe("pane drag helpers", () => {
  it("recognises the pane type case-insensitively", () => {
    expect(hasPaneDrag(["Files", "Application/X-Container-Files-Pane"])).toBe(
      true,
    );
    expect(hasPaneDrag(["text/plain"])).toBe(false);
    expect(hasPaneDrag(null)).toBe(false);
  });

  it("sets data synchronously and defers the state update", () => {
    const data = { set: [] as string[][], effectAllowed: "" };
    const started: string[] = [];
    let flush: (() => void) | undefined;
    const cancel = startPaneDrag(
      {
        setData: (f, v) => data.set.push([f, v]),
        get effectAllowed() {
          return data.effectAllowed;
        },
        set effectAllowed(v: string) {
          data.effectAllowed = v;
        },
      },
      "pane-2",
      (id) => started.push(id),
      (run) => {
        flush = run;
        return () => (flush = undefined);
      },
    );
    expect(data.set).toEqual([
      ["application/x-container-files-pane", "pane-2"],
    ]);
    expect(data.effectAllowed).toBe("move");
    expect(started).toEqual([]);
    flush?.();
    expect(started).toEqual(["pane-2"]);
    cancel();
  });

  it("a dragend before the deferred update cancels it", () => {
    const started: string[] = [];
    let flush: (() => void) | undefined;
    const cancel = startPaneDrag(
      { setData: () => {}, effectAllowed: "" },
      "p",
      (id) => started.push(id),
      (run) => {
        flush = run;
        return () => (flush = undefined);
      },
    );
    cancel();
    flush?.();
    expect(started).toEqual([]);
  });
});

describe("runtimeLabel", () => {
  it("adds the version when known", () => {
    expect(runtimeLabel("docker", "29.0.1")).toBe("Docker 29.0.1");
    expect(runtimeLabel("podman", null)).toBe("Podman");
    expect(runtimeLabel(null, "1")).toBe("");
  });
});

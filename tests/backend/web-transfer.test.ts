import { describe, expect, it } from "vitest";
import {
  collectEntries,
  dirsToCreate,
  fromFileList,
  isSafeRel,
  joinRel,
  pipeToHandle,
  topLevelOf,
} from "../../src/frontend/webTransfer";

const file = (name: string) =>
  ({
    isFile: true,
    isDirectory: false,
    name,
    file: (ok: (f: File) => void) => ok({ name, size: 1 } as File),
  }) as unknown as FileSystemEntry;

/** Directory whose reader hands children out in batches of `batch`. */
const dir = (name: string, children: FileSystemEntry[], batch = 2) =>
  ({
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let i = 0;
      return {
        readEntries: (ok: (e: FileSystemEntry[]) => void) => {
          ok(children.slice(i, i + batch));
          i += batch;
        },
      };
    },
  }) as unknown as FileSystemDirectoryEntry as FileSystemEntry;

describe("path helpers", () => {
  it("joins and splits", () => {
    expect(joinRel("a", "", "b")).toBe("a/b");
    expect(topLevelOf("a/b/c")).toBe("a");
    expect(topLevelOf("x.txt")).toBe("x.txt");
  });
  it("rejects unsafe relative paths", () => {
    expect(isSafeRel("a/b")).toBe(true);
    expect(isSafeRel("../a")).toBe(false);
    expect(isSafeRel("a/../b")).toBe(false);
    expect(isSafeRel("/a")).toBe(false);
    expect(isSafeRel("")).toBe(false);
  });
});

describe("collectEntries", () => {
  it("flattens nested folders across reader batches and keeps empty ones", async () => {
    const tree = dir("root", [
      file("a.txt"),
      dir("sub", [file("b.txt"), dir("deep", [file("c.txt")])]),
      dir("empty", []),
      file("d.txt"),
      file("e.txt"),
    ]);
    const plan = await collectEntries([tree, file("top.txt")]);
    expect(plan.files.map((f) => f.rel).sort()).toEqual([
      "root/a.txt",
      "root/d.txt",
      "root/e.txt",
      "root/sub/b.txt",
      "root/sub/deep/c.txt",
      "top.txt",
    ]);
    expect(plan.emptyDirs).toEqual(["root/empty"]);
  });

  it("rejects entries that would escape the destination", async () => {
    const plan = await collectEntries([file(".."), dir("..", [file("x")])]);
    expect(plan.files).toEqual([]);
  });
});

describe("fromFileList / dirsToCreate", () => {
  it("uses webkitRelativePath when present", () => {
    const f = { name: "a.txt", webkitRelativePath: "dir/a.txt" } as File;
    const g = { name: "b.txt", webkitRelativePath: "" } as File;
    expect(fromFileList([f, g]).files.map((x) => x.rel)).toEqual([
      "dir/a.txt",
      "b.txt",
    ]);
  });
  it("skips empty dirs already implied by files", () => {
    expect(
      dirsToCreate({
        files: [{ file: {} as File, rel: "a/b/c.txt" }],
        emptyDirs: ["a/b", "a/e"],
      }),
    ).toEqual(["a/e"]);
  });
});

describe("pipeToHandle", () => {
  const stream = (chunks: Uint8Array[], fail = false) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(ch);
        if (fail) c.error(new Error("boom"));
        else c.close();
      },
    });
  const makeHandle = () => {
    const log = { written: 0, closed: false, aborted: false };
    return {
      log,
      handle: {
        createWritable: async () => ({
          write: async (c: Uint8Array) => void (log.written += c.length),
          close: async () => void (log.closed = true),
          abort: async () => void (log.aborted = true),
        }),
      },
    };
  };

  it("writes every chunk, reports progress and closes", async () => {
    const { log, handle } = makeHandle();
    const seen: number[] = [];
    const n = await pipeToHandle(
      stream([new Uint8Array(3), new Uint8Array(4)]),
      handle,
      { onProgress: (l) => seen.push(l) },
    );
    expect(n).toBe(7);
    expect(seen).toEqual([3, 7]);
    expect(log.closed).toBe(true);
  });

  it("aborts the partial file on stream error", async () => {
    const { log, handle } = makeHandle();
    await expect(
      pipeToHandle(stream([new Uint8Array(1)], true), handle),
    ).rejects.toThrow("boom");
    expect(log.aborted).toBe(true);
    expect(log.closed).toBe(false);
  });

  it("aborts when the signal fires", async () => {
    const { log, handle } = makeHandle();
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      pipeToHandle(stream([new Uint8Array(1)]), handle, {
        signal: ctl.signal,
      }),
    ).rejects.toThrow();
    expect(log.aborted).toBe(true);
  });
});

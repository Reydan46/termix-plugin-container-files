import { describe, expect, it } from "vitest";
import { compress, extract } from "../../src/backend/fs-ops";
import {
  OpProgress,
  OpProgressRegistry,
  parseDuKb,
  parseUnzipTotal,
  parseWcBytes,
  percentOf,
} from "../../src/backend/op-progress";
import { HttpError } from "../../src/backend/helpers";
import type { ListTarget } from "../../src/backend/fs-list";
import {
  formatElapsed,
  progressPercent,
} from "../../src/frontend/archiveProgressHelpers";
import { FakeClient } from "./fake-ssh";

const make = (
  client: FakeClient,
  tools = ["tar", "zip", "unzip"],
): ListTarget => ({
  client: client.asClient(),
  runtime: "docker",
  containerId: "abc",
  capabilities: {
    running: true,
    exec: true,
    findPrintf: true,
    statC: true,
    tools,
  },
});

describe("progress parsing", () => {
  it("sums du -sk lines in bytes", () => {
    expect(parseDuKb("4\ta\n10\tb c\n")).toBe(14 * 1024);
    expect(parseDuKb("")).toBeUndefined();
    expect(parseDuKb("du: nope\n")).toBeUndefined();
  });
  it("reads wc -c and the unzip -l total", () => {
    expect(parseWcBytes("  1234\n")).toBe(1234);
    expect(parseWcBytes("x")).toBeUndefined();
    expect(
      parseUnzipTotal("Archive: a.zip\n  Length  Date\n---\n    12  2 files\n"),
    ).toBe(12);
    expect(parseUnzipTotal("Archive: a.zip\n")).toBeUndefined();
  });
  it("never reports 100% before the end", () => {
    expect(percentOf({ processedBytes: 50, totalBytes: 100 })).toBe(50);
    expect(percentOf({ processedBytes: 500, totalBytes: 100 })).toBe(99);
    expect(percentOf({ processedBytes: 5 })).toBeUndefined();
    expect(progressPercent(null)).toBeUndefined();
    expect(progressPercent({ processedBytes: 1, totalBytes: 4 })).toBe(25);
  });
  it("formats elapsed time", () => {
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(3_661_000)).toBe("1:01:01");
    expect(formatElapsed(-5)).toBe("0:00");
  });
});

describe("OpProgress state machine", () => {
  it("tracks stages and ends once", () => {
    const p = new OpProgress("compress-12345678", "u", "compress");
    expect(p.view()).toMatchObject({ status: "running", stage: "preparing" });
    p.setStage("packing");
    p.setTotal(100, true);
    p.setProcessed(40);
    expect(p.view()).toMatchObject({
      stage: "packing",
      processedBytes: 40,
      totalBytes: 100,
      approximate: true,
    });
    p.finish();
    p.finish(new Error("late"));
    p.setStage("scanning");
    expect(p.view()).toMatchObject({ status: "done", stage: "packing" });
  });
  it("maps errors and cancellation", () => {
    const e = new OpProgress("extract-12345678", "u", "extract");
    e.finish(new HttpError(500, "boom"));
    expect(e.status).toBe("error");
    const c = new OpProgress("extract-12345679", "u", "extract");
    c.finish(new HttpError(499, "Cancelled", "CANCELLED"));
    expect(c.status).toBe("cancelled");
  });
  it("hides approximate without a total", () => {
    const p = new OpProgress("compress-12345678", "u", "compress");
    p.setTotal(0, true);
    expect(p.view().approximate).toBeUndefined();
  });
  it("registry scopes ops to their user and ignores bad ids", () => {
    const r = new OpProgressRegistry();
    expect(r.start("x", "u", "compress")).toBeUndefined();
    expect(r.start(undefined, "u", "compress")).toBeUndefined();
    r.start("compress-12345678", "u", "compress");
    expect(r.get("compress-12345678", "u")).toBeDefined();
    expect(r.get("compress-12345678", "other")).toBeUndefined();
  });
});

describe("registry protection", () => {
  it("refuses to replace running or foreign entries", () => {
    const r = new OpProgressRegistry();
    const a = r.start("compress-12345678", "u", "compress")!;
    expect(r.start("compress-12345678", "u", "compress")).toBeUndefined();
    a.finish();
    expect(r.start("compress-12345678", "other", "compress")).toBeUndefined();
    expect(r.get("compress-12345678", "u")).toBe(a);
    expect(r.start("compress-12345678", "u", "compress")).not.toBe(a);
  });
  it("evicts only finished ops past the grace period", () => {
    const r = new OpProgressRegistry();
    const ops: OpProgress[] = [];
    for (let i = 0; i < 200; i++) {
      const id = `compress-${String(i).padStart(8, "0")}`;
      ops.push(r.start(id, "u", "compress")!);
    }
    expect(r.start("compress-new00001", "u", "compress")).toBeUndefined();
    ops[5].finish();
    expect(r.start("compress-new00001", "u", "compress")).toBeUndefined();
    ops[5].finishedAt = Date.now() - 120_000;
    ops[7].finish();
    expect(r.start("compress-new00001", "u", "compress")).toBeDefined();
    expect(r.get(ops[5].id, "u")).toBeUndefined();
    expect(r.get(ops[7].id, "u")).toBe(ops[7]);
  });
});

describe("compress / extract report progress", () => {
  it("compress goes scanning -> packing -> finishing with an approximate total", async () => {
    const client = new FakeClient([
      [/du -sk/, { stdout: "100\tdocs\n" }],
      [/wc -c/, { stdout: "2048\n" }],
      [/tar -czf/, (s) => setTimeout(() => s.finish("", 0), 1600)],
    ]);
    const p = new OpProgress("compress-12345678", "u", "compress");
    const stages: string[] = [];
    const orig = p.setStage.bind(p);
    p.setStage = (s) => {
      stages.push(s);
      orig(s);
    };
    await compress(make(client), "/d", ["docs"], "/d/a.tgz", "tgz", {
      progress: p,
    });
    expect(stages).toEqual(["preparing", "scanning", "packing", "finishing"]);
    expect(p.totalBytes).toBe(100 * 1024);
    expect(p.approximate).toBe(true);
    expect(p.processedBytes).toBe(2048);
    // sources reach the probe as positional arguments
    expect(client.commands.find((c) => c.includes("du -sk"))).toContain(
      "'docs'",
    );
  });

  it("compress without progress runs no probes", async () => {
    const client = new FakeClient();
    await compress(make(client), "/d", ["a"], "/d/a.tar", "tar");
    expect(client.commands.some((c) => c.includes("du -sk"))).toBe(false);
  });

  it("extract of a zip gets the uncompressed total from unzip -l", async () => {
    const client = new FakeClient([
      [/unzip -l/, { stdout: "Archive: a.zip\n   500  3 files\n" }],
      [/du -sk/, { stdout: "0\t/x\n" }],
    ]);
    const p = new OpProgress("extract-12345678", "u", "extract");
    await extract(make(client), "/a.zip", "/x", true, { progress: p });
    expect(p.totalBytes).toBe(500);
    expect(p.stage).toBe("finishing");
  });

  it("extract of a .tar.gz stays indeterminate", async () => {
    const client = new FakeClient();
    const p = new OpProgress("extract-12345678", "u", "extract");
    await extract(make(client), "/a.tar.gz", "/x", true, { progress: p });
    expect(p.view().totalBytes).toBeUndefined();
  });
});

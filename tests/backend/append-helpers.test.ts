import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APPEND_REASONS,
  appendErrorKey,
  appendBlock,
  appendBlockAll,
  appendKind,
  appendDragPaths,
  appendDropHintFor,
  appendSources,
  appendTool,
  canAppendTo,
  isAppendDropTarget,
} from "../../src/frontend/appendHelpers";

const dropSourcesFor = (n: string) =>
  appendSources([file("x.txt")], `/d/${n}`).length > 0;

const file = (name: string, type = "file") => ({
  name,
  type,
  path: `/d/${name}`,
});

describe("append helpers", () => {
  it("accepts the archive extensions only", () => {
    for (const n of [
      "a.zip",
      "a.tar",
      "a.tgz",
      "a.tar.gz",
      "a.tar.bz2",
      "a.tar.xz",
      "a.tar.zst",
      "a.tzst",
      "a.7z",
      "a.jar",
      "A.ZIP",
    ]) {
      expect(canAppendTo(n), n).toBe(true);
    }
    for (const n of ["a.txt", "a.gz", "a.zst", "a.rar", "zip", "a.zip.bak"]) {
      expect(canAppendTo(n), n).toBe(false);
    }
  });

  it.each([
    "a.zip",
    "a.tar",
    "a.tar.gz",
    "a.tgz",
    "a.tar.bz2",
    "a.tbz2",
    "a.tar.xz",
    "a.txz",
  ])("accepts %s on the menu and drop paths alike", (n) => {
    expect(canAppendTo(n)).toBe(true);
    expect(isAppendDropTarget(file(n), "/d")).toBe(true);
    expect(dropSourcesFor(n)).toBe(true);
  });

  it("takes in-app drags of the same container only", () => {
    const drag = { containerId: "c1", paths: ["/d/a"] };
    expect(appendDragPaths(drag, "c1")).toEqual(["/d/a"]);
    expect(appendDragPaths(drag, "c2")).toBeNull();
    expect(
      appendDragPaths({ containerId: null, paths: ["/x"] }, "c1"),
    ).toBeNull();
    expect(appendDragPaths({ containerId: "c1", paths: [] }, "c1")).toBeNull();
    expect(appendDragPaths(null, "c1")).toBeNull();
  });

  it("picks the tool by archive type", () => {
    expect(appendTool("a.zip")).toBe("zip");
    expect(appendTool("a.tar.gz")).toBe("tar");
  });

  it("allows drops on archive files in real folders only", () => {
    expect(isAppendDropTarget(file("a.zip"), "/d")).toBe(true);
    expect(isAppendDropTarget(file("a.txt"), "/d")).toBe(false);
    expect(isAppendDropTarget(file("a.zip", "directory"), "/d")).toBe(false);
    expect(isAppendDropTarget(file("a.zip"), "/x.tar!/sub")).toBe(false);
    expect(
      isAppendDropTarget({ ...file("a.zip"), path: "/x.tar!/a.zip" }, "/d"),
    ).toBe(false);
  });

  it("leaves out the archive itself and its parents", () => {
    const items = [file("a.zip"), file("b"), { name: "d", path: "/d" }];
    expect(appendSources(items, "/d/a.zip").map((f) => f.name)).toEqual(["b"]);
  });

  it("maps refusals to locale keys", () => {
    expect(appendErrorKey("APPEND_UNSUPPORTED", "busybox-tar")).toBe(
      "containerFiles.appendUnsupported.busybox-tar",
    );
    expect(appendErrorKey("APPEND_UNSUPPORTED", undefined)).toBe(
      "containerFiles.appendUnsupported.format",
    );
    expect(appendErrorKey("ARCHIVE_READ_ONLY", undefined)).toBe(
      "containerFiles.appendReadOnly",
    );
    expect(appendErrorKey("INCLUDES_ARCHIVE", undefined)).toBe(
      "containerFiles.appendIncludesArchive",
    );
    expect(appendErrorKey("NOT_FOUND", undefined)).toBeNull();
    expect(APPEND_REASONS).toHaveLength(6);
  });
});

describe("append locale keys", () => {
  const en = JSON.parse(readFileSync("locales-src/en.json", "utf8"));
  const ru = JSON.parse(readFileSync("locales-src/ru.json", "utf8"));
  const at = (tree: unknown, key: string) =>
    key
      .split(".")
      .reduce<unknown>(
        (o, k) => (o as Record<string, unknown> | undefined)?.[k],
        tree,
      );

  it("has every key in en and ru", () => {
    const keys = [
      "appendMenu",
      "appendPickTitle",
      "appendingName",
      "appendDone",
      "appendFailed",
      "appendConfirmTitle",
      "appendConfirmDesc",
      "appendConfirm",
      "appendDropHint",
      "appendReadOnly",
      "appendIncludesArchive",
      "appendBlocked.busyboxTar",
      "appendBlocked.noTool",
      ...APPEND_REASONS.map((r) => `appendUnsupported.${r}`),
    ].map((k) => `containerFiles.${k}`);
    for (const key of keys) {
      expect(typeof at(en, key), `en ${key}`).toBe("string");
      expect(typeof at(ru, key), `ru ${key}`).toBe("string");
    }
    for (const reason of APPEND_REASONS) {
      expect(appendErrorKey("APPEND_UNSUPPORTED", reason)).toBe(
        `containerFiles.appendUnsupported.${reason}`,
      );
    }
  });
});

describe("append preflight message", () => {
  const t = (k: string, p?: Record<string, unknown>) =>
    p?.tool ? `${k}:${p.tool}` : k;
  const ok = { ok: true } as const;
  const caps = (over: Record<string, unknown>) => ({
    exec: true,
    appendSupport: { zip: ok, tar: ok, tgz: ok, tbz: ok, txz: ok, ...over },
  });
  const busy = { ok: false, reason: "busybox-tar" } as const;

  it("maps archive names to kinds", () => {
    expect(appendKind("a.TAR.GZ")).toBe("tgz");
    expect(appendKind("a.tbz2")).toBe("tbz");
    expect(appendKind("a.txz")).toBe("txz");
    expect(appendKind("a.zip")).toBe("zip");
    expect(appendKind("a.txt")).toBeNull();
  });

  it("explains BusyBox for tar kinds only", () => {
    const c = caps({ tar: busy, tgz: busy, tbz: busy, txz: busy });
    expect(appendBlock(c, "a.tar", t)).toBe(
      "containerFiles.appendBlocked.busyboxTar",
    );
    expect(appendBlock(c, "a.tar.xz", t)).toBe(
      "containerFiles.appendBlocked.busyboxTar",
    );
    expect(appendBlock(c, "a.zip", t)).toBeNull();
    expect(appendBlockAll(c, t)).toBeNull();
  });

  it("names the missing tool", () => {
    const c = caps({ tgz: { ok: false, reason: "no-tool", tool: "gzip" } });
    expect(appendBlock(c, "x.tgz", t)).toBe(
      "containerFiles.appendBlocked.noTool:gzip",
    );
    expect(appendBlock(c, "x.tar", t)).toBeNull();
  });

  it("refuses the menu only when no type works", () => {
    const all = caps({
      zip: { ok: false, reason: "no-tool", tool: "zip" },
      tar: busy,
      tgz: busy,
      tbz: busy,
      txz: busy,
    });
    expect(appendBlockAll(all, t)).toBe(
      "containerFiles.appendBlocked.noTool:zip",
    );
  });

  it("falls back to trying when the server sends no verdict", () => {
    expect(appendBlock({ exec: true }, "a.tar", t)).toBeNull();
    expect(appendBlock(null, "a.tar", t)).toBeNull();
    expect(appendBlockAll({ exec: true }, t)).toBeNull();
  });
});

describe("appendDropHintFor", () => {
  const t = (k: string, o?: Record<string, unknown>) =>
    o ? `${k}:${JSON.stringify(o)}` : k;
  const ok = { ok: true } as const;
  const caps = (tar: object) =>
    ({
      exec: true,
      appendSupport: { zip: ok, tar, tgz: tar, tbz: tar, txz: tar },
    }) as never;
  const busy = { ok: false, reason: "busybox-tar" };
  const drag = [file("x.txt")];

  it("allows a drop on an archive that can take an append", () => {
    const h = appendDropHintFor(drag, file("a.tar"), "/d", caps(ok), t);
    expect(h?.kind).toBe("allow");
  });

  it("names the reason when the probe says it cannot", () => {
    const h = appendDropHintFor(drag, file("a.tar"), "/d", caps(busy), t);
    expect(h).toEqual({
      kind: "blocked",
      text: "containerFiles.appendBlocked.busyboxTar",
    });
    const z = appendDropHintFor(drag, file("a.zip"), "/d", caps(ok), t);
    expect(z?.kind).toBe("allow");
    const noZip = {
      exec: true,
      appendSupport: {
        ...(caps(ok) as any).appendSupport,
        zip: { ok: false, reason: "no-tool", tool: "zip" },
      },
    } as never;
    expect(appendDropHintFor(drag, file("a.zip"), "/d", noZip, t)).toEqual({
      kind: "blocked",
      text: 'containerFiles.appendBlocked.noTool:{"tool":"zip"}',
    });
  });

  it("shows nothing for non-archives, directories, itself or an older server", () => {
    expect(
      appendDropHintFor(drag, file("a.txt"), "/d", caps(busy), t),
    ).toBeNull();
    expect(
      appendDropHintFor(drag, file("a.tar", "directory"), "/d", caps(busy), t),
    ).toBeNull();
    expect(
      appendDropHintFor([file("a.tar")], file("a.tar"), "/d", caps(busy), t),
    ).toBeNull();
    expect(
      appendDropHintFor(drag, file("a.tar"), "/d", { exec: true } as never, t)
        ?.kind,
    ).toBe("allow");
    expect(appendDropHintFor(drag, file("a.tar"), "/d", null, t)?.kind).toBe(
      "allow",
    );
  });
});

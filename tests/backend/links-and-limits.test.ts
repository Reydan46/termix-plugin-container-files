import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import tar from "tar-stream";
import {
  listDirectory,
  type FileEntry,
  type ListTarget,
} from "../../src/backend/fs-list";
import {
  classifyFailure,
  parseProbe,
  type Capabilities,
} from "../../src/backend/capabilities";
import { toFileItem } from "../../src/frontend/containerFsApi";
import {
  LIMIT_KEYS,
  capabilityBanner,
  listingDetail,
  degradedNotes,
  featureBlock,
  FEATURES,
  FEATURE_TOOLS,
  type Translate,
} from "../../src/frontend/capabilityMessages";
import { FakeClient } from "./fake-ssh";

const nul = (...f: string[]) => f.join("\0") + "\0";

const caps = {
  running: true,
  exec: true,
  findPrintf: true,
  statC: true,
  tools: [],
};
const make = (
  client: FakeClient,
  capabilities: Capabilities = caps,
): ListTarget => ({
  client: client.asClient(),
  runtime: "docker",
  containerId: "abc",
  capabilities,
});

const wire = (e: FileEntry) => ({ ...e });
const itemOf = (e: FileEntry) => toFileItem("k", "/d", wire(e) as never);

describe("symlinks in every listing tier", () => {
  it("find tier: link to a directory, to a file, dangling", async () => {
    const client = new FakeClient([
      [
        /find -H/,
        {
          stdout:
            nul("ld", "l", "1", "1", "777", "r", "r", "/etc", "d") +
            nul("lf", "l", "1", "1", "777", "r", "r", "a.txt", "f") +
            nul("lm", "l", "1", "1", "777", "r", "r", "/gone", "N"),
        },
      ],
    ]);
    const res = await listDirectory(make(client), "/d");
    expect(res.entries.map((e) => e.linkKind)).toEqual([
      "directory",
      "file",
      "missing",
    ]);
    const items = res.entries.map(itemOf);
    expect(items.map((i) => i.type)).toEqual(["directory", "file", "link"]);
    expect(items.map((i) => i.linkTarget)).toEqual(["/etc", "a.txt", "/gone"]);
  });

  it("stat tier: link info comes from the links script", async () => {
    const client = new FakeClient([
      [
        /-type l/,
        {
          stdout:
            nul("/d/ld", "d", "/etc") +
            nul("/d/lf", "f", "a.txt") +
            nul("/d/lm", "m", "/gone"),
        },
      ],
      [
        /stat -c/,
        {
          stdout: [
            "symbolic link|1|1|777|r|r|/d/ld",
            "symbolic link|1|1|777|r|r|/d/lf",
            "symbolic link|1|1|777|r|r|/d/lm",
          ].join("\n"),
        },
      ],
    ]);
    const res = await listDirectory(
      make(client, { ...caps, findPrintf: false }),
      "/d",
    );
    expect(res.tier).toBe("stat");
    expect(res.entries.map((e) => e.linkKind)).toEqual([
      "directory",
      "file",
      "missing",
    ]);
    expect(res.entries.map(itemOf).map((i) => i.type)).toEqual([
      "directory",
      "file",
      "link",
    ]);
  });

  it("cp tier: sibling targets are classified, others stay unknown", async () => {
    const pack = tar.pack();
    pack.entry({ name: "d/", type: "directory" });
    pack.entry({ name: "d/sub/", type: "directory" });
    pack.entry({ name: "d/a.txt", size: 1 }, "x");
    pack.entry({ name: "d/ld", type: "symlink", linkname: "sub" });
    pack.entry({ name: "d/lf", type: "symlink", linkname: "./a.txt" });
    pack.entry({ name: "d/lx", type: "symlink", linkname: "/etc" });
    pack.finalize();
    const chunks: Buffer[] = [];
    for await (const c of pack) chunks.push(c as Buffer);
    const client = new FakeClient([
      [/'cp'/, { stdout: Buffer.concat(chunks) }],
    ]);
    const res = await listDirectory(
      make(client, { ...caps, exec: false, running: false }),
      "/d",
    );
    const by = (n: string) => res.entries.find((e) => e.name === n)!;
    expect(by("ld").linkKind).toBe("directory");
    expect(by("lf").linkKind).toBe("file");
    expect(by("lx").linkKind).toBeUndefined();
    // Unknown kinds stay "link"; the file manager resolves them on open.
    expect(itemOf(by("lx")).type).toBe("link");
    expect(itemOf(by("ld"))).toMatchObject({
      type: "directory",
      linkTarget: "sub",
    });
  });
});

describe("classifyFailure", () => {
  const base = { running: true, stdout: "", code: 126 as number | null };
  it("stopped and paused containers", () => {
    expect(
      classifyFailure({
        ...base,
        running: false,
        status: "exited",
        stderr: "",
        code: null,
      }),
    ).toMatchObject({ reason: "stopped" });
    expect(
      classifyFailure({
        ...base,
        running: false,
        status: "paused",
        stderr: "",
        code: null,
      }),
    ).toMatchObject({ reason: "paused" });
  });

  it("image without a shell (docker and podman wording)", () => {
    expect(
      classifyFailure({
        ...base,
        stderr:
          'OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not found in $PATH: unknown',
      }).reason,
    ).toBe("no-shell");
    expect(
      classifyFailure(
        {
          ...base,
          code: 127,
          stderr:
            "Error: crun: executable file `sh` not found in $PATH: No such file or directory: OCI runtime attempted to invoke a command that was not found",
        },
        "podman",
      ).reason,
    ).toBe("no-shell");
  });

  it("exec not permitted, with rootless podman detected", () => {
    const r = classifyFailure(
      {
        ...base,
        code: 255,
        stderr:
          "Error: OCI permission denied: setns: user namespace: operation not permitted\nmore",
      },
      "podman",
    );
    expect(r).toMatchObject({ reason: "exec-denied", rootless: true });
    expect(r.detail).toContain("permission denied");
    expect(
      classifyFailure({ ...base, stderr: "permission denied" }, "docker")
        .rootless,
    ).toBe(false);
  });

  it("race with a stopped or paused container and unknown errors", () => {
    expect(
      classifyFailure({
        ...base,
        code: 1,
        stderr: "Error: container abc is not running",
      }).reason,
    ).toBe("stopped");
    expect(
      classifyFailure({
        ...base,
        code: 1,
        stderr: "Container abc is paused, unpause the container",
      }).reason,
    ).toBe("paused");
    expect(
      classifyFailure({ ...base, code: 1, stderr: "something odd happened" }),
    ).toMatchObject({
      reason: "exec-failed",
      detail: "something odd happened",
    });
  });
});

const en = JSON.parse(readFileSync("locales-src/en.json", "utf8"));
const ru = JSON.parse(readFileSync("locales-src/ru.json", "utf8"));
const lookup = (tree: Record<string, unknown>, key: string) =>
  key
    .split(".")
    .reduce<unknown>(
      (o, k) => (o as Record<string, unknown> | undefined)?.[k],
      tree,
    );
const makeT =
  (tree: Record<string, unknown>): Translate =>
  (key, params) =>
    String(lookup(tree, key) ?? `?${key}`).replace(/\{\{(\w+)\}\}/g, (_, p) =>
      String(params?.[p] ?? ""),
    );

describe("capability messages", () => {
  it("has every key in en and ru", () => {
    for (const key of LIMIT_KEYS) {
      expect(typeof lookup(en, key), `en ${key}`).toBe("string");
      expect(typeof lookup(ru, key), `ru ${key}`).toBe("string");
    }
  });

  const down = (c: Partial<Capabilities>): Capabilities => ({
    ...parseProbe("", true),
    ...c,
  });

  it("gives a distinct reason per limitation, in both languages", () => {
    for (const tree of [en, ru]) {
      const t = makeT(tree);
      const texts = (
        [
          { running: false, reason: "stopped" },
          { running: false, reason: "paused" },
          { reason: "exec-denied", detail: "denied" },
          { reason: "exec-denied", rootless: true },
          { reason: "no-shell" },
          { reason: "exec-failed", detail: "boom" },
        ] as Partial<Capabilities>[]
      ).map((c) => featureBlock(down(c), "delete", t)!);
      expect(texts.every(Boolean)).toBe(true);
      expect(texts.every((x) => !x.includes("?containerFiles"))).toBe(true);
      expect(new Set(texts).size).toBe(texts.length);
      expect(texts[2]).toContain("denied");
      expect(texts[5]).toContain("boom");
    }
  });

  it("names the missing tool and degraded listing", () => {
    const t = makeT(en);
    const c = down({
      exec: true,
      findPrintf: false,
      statC: true,
      tools: ["mv", "rm"],
    });
    expect(featureBlock(c, "compress", t)).toContain("tar is not installed");
    expect(featureBlock(c, "extract", t, "unzip")).toContain("unzip");
    expect(featureBlock(c, "delete", t)).toBeNull();
    // The stat tier is neutral: no warning note, only a tooltip detail.
    expect(degradedNotes(c, t).join(" ")).not.toContain("stat");
    expect(listingDetail(c, t)).toContain("stat");
    expect(capabilityBanner(c, t)?.text).toContain("Some tools are missing");
    const stat = down({ exec: true, findPrintf: false, statC: true });
    stat.tools = [...FEATURES.flatMap((f) => FEATURE_TOOLS[f])];
    expect(capabilityBanner(stat, t)).toBeNull();
    expect(listingDetail(stat, t)).toContain("stat");
    expect(listingDetail(down({ exec: true, findPrintf: true }), t)).toBeNull();
    expect(
      degradedNotes(down({ exec: true, statC: false, tools: [] }), t)[0],
    ).toContain("archive copy");
  });

  it("banner says what still works when nothing can run", () => {
    const b = capabilityBanner(down({ reason: "no-shell" }), makeT(en))!;
    expect(b.tone).toBe("warn");
    expect(b.text).toContain("no shell");
    expect(b.text).toContain("downloading still work");
  });
});

import { describe, expect, it } from "vitest";
import {
  computeAppendSupport,
  getCapabilities,
  parseProbe,
} from "../../src/backend/capabilities";
import type { ContainerSession } from "../../src/backend/sessions";
import { FakeClient } from "./fake-ssh";

function sessionFor(probeOut: string) {
  const client = new FakeClient([
    [/'inspect'/, { stdout: "abc123def|true|running|/web\n" }],
    [/tarFlavor/, { stdout: probeOut }],
  ]);
  const session = {
    client: client.asClient(),
    runtime: "docker",
    states: new Map(),
    mounts: new Map(),
    capabilities: new Map(),
  } as unknown as ContainerSession;
  return { client, session };
}

const probed = (tar: string, tools: string[]) =>
  `${["find", "tar", "zip", ...tools].map((t) => `tool:${t}`).join("\n")}\n${tar}\nprobed\n`;

describe("append support probe", () => {
  it("GNU tar with every tool allows every format", async () => {
    const { session } = sessionFor(
      probed("tarFlavor:gnu", ["gzip", "bzip2", "xz", "zstd", "7zz"]),
    );
    const caps = await getCapabilities(session, "abc123def");
    expect(caps.tarFlavor).toBe("gnu");
    expect(Object.values(caps.appendSupport!).every((v) => v.ok)).toBe(true);
  });

  it("BusyBox tar refuses every tar kind but not zip", async () => {
    const { session } = sessionFor(
      probed("tarFlavor:busybox", ["gzip", "bzip2", "xz", "zstd", "7z"]),
    );
    const caps = await getCapabilities(session, "abc123def");
    expect(caps.tarFlavor).toBe("busybox");
    const s = caps.appendSupport!;
    expect(s.zip).toEqual({ ok: true });
    for (const k of ["tar", "tgz", "tbz", "txz", "tzst"] as const)
      expect(s[k]).toEqual({ ok: false, reason: "busybox-tar" });
    expect(s["7z"]).toEqual({ ok: true });
  });

  it("names a missing gzip or xz only for its own format", () => {
    const s = computeAppendSupport(["tar", "zip", "bzip2"], "gnu");
    expect(s.tar).toEqual({ ok: true });
    expect(s.tbz).toEqual({ ok: true });
    expect(s.tgz).toEqual({ ok: false, reason: "no-tool", tool: "gzip" });
    expect(s.txz).toEqual({ ok: false, reason: "no-tool", tool: "xz" });
  });

  it("names a missing zip or tar", () => {
    const s = computeAppendSupport([], undefined);
    expect(s.zip).toEqual({ ok: false, reason: "no-tool", tool: "zip" });
    expect(s.tgz).toEqual({ ok: false, reason: "no-tool", tool: "tar" });
  });

  it("probes once and caches the verdict", async () => {
    const { client, session } = sessionFor(probed("tarFlavor:gnu", []));
    const a = await getCapabilities(session, "abc123def");
    const n = client.commands.filter((c) => /tarFlavor/.test(c)).length;
    const b = await getCapabilities(session, "abc123def");
    expect(b).toBe(a);
    expect(client.commands.filter((c) => /tarFlavor/.test(c))).toHaveLength(n);
  });

  it("gives no verdict when exec does not work or the output is old", () => {
    expect(parseProbe("tool:tar\n", true).appendSupport).toBeUndefined();
    expect(parseProbe("", false).appendSupport).toBeUndefined();
    // An old probe output (no tarFlavor line) still yields a verdict by tools.
    expect(parseProbe("tool:tar\nprobed\n", true).tarFlavor).toBeUndefined();
  });
});

import { runCommand } from "./exec.js";
import { execScriptCommand } from "./shell-quote.js";
import { firstTool, SEVENZ_TOOLS } from "./archive-kinds.js";
import { getContainerState } from "./containers.js";
import type { ContainerSession } from "./sessions.js";

/** What can be done inside one container, in its current state. */
export interface Capabilities {
  running: boolean;
  /** `docker exec sh` works. Without it only `cp`-based access exists. */
  exec: boolean;
  /** GNU find with -printf (fast listing). */
  findPrintf: boolean;
  /** `stat -c` (BusyBox or GNU). */
  statC: boolean;
  tools: string[];
  /** Which tar the container has; absent when none was found. */
  tarFlavor?: TarFlavor;
  /** Per archive kind: whether files can be added to such an archive. */
  appendSupport?: AppendSupport;
  /** Per archive kind: whether entries can be deleted from such an archive. */
  deleteSupport?: DeleteSupport;
  /** Why `exec` is false (machine-readable); absent when exec works. */
  reason?: LimitReason;
  /** Engine status (running, paused, exited, ...). */
  status?: string;
  /** Informative first line of the failing probe's stderr. */
  detail?: string;
  /** Podman rootless symptoms were seen in the failure. */
  rootless?: boolean;
}

export type TarFlavor = "gnu" | "busybox" | "bsd" | "other";

export type AppendVerdict =
  | { ok: true }
  | { ok: false; reason: "busybox-tar" | "no-tool"; tool?: string };

export type AppendKind = "zip" | "tar" | "tgz" | "tbz" | "txz" | "tzst" | "7z";

export type AppendSupport = Record<AppendKind, AppendVerdict>;

export type DeleteVerdict =
  { ok: true } | { ok: false; reason: "gnu-tar" | "no-tool"; tool?: string };

export type DeleteSupport = Record<AppendKind, DeleteVerdict>;

const COMPRESSORS = {
  tgz: "gzip",
  tbz: "bzip2",
  txz: "xz",
  tzst: "zstd",
} as const;

/** Name a missing 7z tool the way the messages do. */
const SEVENZ_LABEL = "7z";

/**
 * What the append script (archive-append.ts) will be able to do, decided from
 * the probe: zip needs zip; 7z needs any 7-Zip build; tar needs a tar that is
 * not BusyBox; compressed tars also need their compressor.
 */
export function computeAppendSupport(
  tools: string[],
  tarFlavor: TarFlavor | undefined,
): AppendSupport {
  const has = (tool: string) => tools.includes(tool);
  const noTool = (tool: string): AppendVerdict => ({
    ok: false,
    reason: "no-tool",
    tool,
  });
  const tarVerdict = (): AppendVerdict =>
    !has("tar")
      ? noTool("tar")
      : tarFlavor === "busybox"
        ? { ok: false, reason: "busybox-tar" }
        : { ok: true };
  const compressed = (kind: keyof typeof COMPRESSORS): AppendVerdict => {
    const tar = tarVerdict();
    if (!tar.ok) return tar;
    const tool = COMPRESSORS[kind];
    return has(tool) ? { ok: true } : noTool(tool);
  };
  return {
    zip: has("zip") ? { ok: true } : noTool("zip"),
    tar: tarVerdict(),
    tgz: compressed("tgz"),
    tbz: compressed("tbz"),
    txz: compressed("txz"),
    tzst: compressed("tzst"),
    "7z": firstTool(tools, SEVENZ_TOOLS) ? { ok: true } : noTool(SEVENZ_LABEL),
  };
}

/**
 * What the delete script (archive-delete.ts) will be able to do: zip needs
 * zip, 7z any 7-Zip build, tar kinds need GNU tar (`--delete`) and their
 * compressor. A tar of unknown flavour is tried; BusyBox and bsdtar are not.
 */
export function computeDeleteSupport(
  tools: string[],
  tarFlavor: TarFlavor | undefined,
): DeleteSupport {
  const has = (tool: string) => tools.includes(tool);
  const noTool = (tool: string): DeleteVerdict => ({
    ok: false,
    reason: "no-tool",
    tool,
  });
  const tarVerdict = (): DeleteVerdict =>
    !has("tar")
      ? noTool("tar")
      : tarFlavor === "busybox" || tarFlavor === "bsd"
        ? { ok: false, reason: "gnu-tar" }
        : { ok: true };
  const compressed = (kind: keyof typeof COMPRESSORS): DeleteVerdict => {
    const tar = tarVerdict();
    if (!tar.ok) return tar;
    const tool = COMPRESSORS[kind];
    return has(tool) ? { ok: true } : noTool(tool);
  };
  return {
    zip: has("zip") ? { ok: true } : noTool("zip"),
    tar: tarVerdict(),
    tgz: compressed("tgz"),
    tbz: compressed("tbz"),
    txz: compressed("txz"),
    tzst: compressed("tzst"),
    "7z": firstTool(tools, SEVENZ_TOOLS) ? { ok: true } : noTool(SEVENZ_LABEL),
  };
}

export type LimitReason =
  "stopped" | "paused" | "exec-denied" | "no-shell" | "exec-failed";

const SHELL_MISSING =
  /executable file[^\n]*not found|exec: "?`?(?:\/bin\/)?sh`?"?|sh: (?:no such file|not found)|no such file or directory.*\bsh\b|\bsh\b[^\n]*no such file or directory|oci runtime[^\n]*(?:not found|no such file)/i;
const EXEC_DENIED =
  /permission denied|operation not permitted|not permitted|access denied|user namespace|newuidmap|newgidmap|setns|cannot (?:open|setup|join)|unable to (?:enter|join)|seccomp|cgroup|apparmor|selinux/i;
const NOT_RUNNING =
  /is not running|container state improper|can only create exec sessions on running/i;
const PAUSED = /is paused|cannot exec in a paused|paused container/i;
const ROOTLESS =
  /rootless|user namespace|newuidmap|newgidmap|setns|\/run\/user\//i;

/** First informative line of stderr, trimmed to a sane length. */
export function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return line ? line.slice(0, 300) : "";
}

export interface ProbeOutcome {
  running: boolean;
  /** Engine status, e.g. "running", "paused", "exited". */
  status?: string;
  stdout: string;
  stderr: string;
  code: number | null;
  /** The exec call itself threw (transport error). */
  error?: string;
}

/** Decides why the exec probe failed. Pure: stderr + state in, reason out. */
export function classifyFailure(
  o: ProbeOutcome,
  runtime: "docker" | "podman" = "docker",
): Pick<Capabilities, "reason" | "detail" | "rootless"> {
  const text = `${o.stderr}\n${o.error ?? ""}`;
  const detail = firstLine(o.stderr) || firstLine(o.error ?? "");
  if (!o.running) {
    return { reason: o.status === "paused" ? "paused" : "stopped" };
  }
  if (PAUSED.test(text)) return { reason: "paused", detail };
  if (NOT_RUNNING.test(text)) return { reason: "stopped", detail };
  const rootless = runtime === "podman" && ROOTLESS.test(text);
  if (EXEC_DENIED.test(text) && !SHELL_MISSING.test(text)) {
    return { reason: "exec-denied", detail, rootless };
  }
  if (SHELL_MISSING.test(text) || o.code === 126 || o.code === 127) {
    return { reason: "no-shell", detail };
  }
  return { reason: "exec-failed", detail, rootless };
}

const TOOLS = [
  "find",
  "stat",
  "tar",
  "unzip",
  "gzip",
  "sha256sum",
  "cp",
  "mv",
  "rm",
  "mkdir",
  "chmod",
  "chown",
  "ln",
  "cat",
  "dd",
  "touch",
  "readlink",
  "du",
  "zip",
  "bzip2",
  "xz",
  "zstd",
  "7zz",
  "7z",
  "7za",
  "7zr",
  "unrar",
  "bsdtar",
];

const PROBE_SCRIPT = `for c in ${TOOLS.join(" ")}; do command -v "$c" >/dev/null 2>&1 && echo "tool:$c"; done
find / -maxdepth 0 -printf '' >/dev/null 2>&1 && echo findPrintf
stat -c %s / >/dev/null 2>&1 && echo statC
if command -v tar >/dev/null 2>&1; then
  case "$(tar --version 2>&1; tar --help 2>&1)" in
    *[Bb]usy[Bb]ox*) echo tarFlavor:busybox ;;
    *GNU*) echo tarFlavor:gnu ;;
    *bsdtar*|*libarchive*) echo tarFlavor:bsd ;;
    *) echo tarFlavor:other ;;
  esac
fi
echo probed`;

export function parseProbe(output: string, running: boolean): Capabilities {
  const lines = new Set(output.split("\n").map((l) => l.trim()));
  const probed = lines.has("probed");
  const tools = [...lines]
    .filter((l) => l.startsWith("tool:"))
    .map((l) => l.slice(5));
  const flavor = [...lines]
    .find((l) => l.startsWith("tarFlavor:"))
    ?.slice("tarFlavor:".length);
  const tarFlavor =
    flavor === "gnu" ||
    flavor === "busybox" ||
    flavor === "bsd" ||
    flavor === "other"
      ? flavor
      : undefined;
  const caps: Capabilities = {
    running,
    exec: running && probed,
    findPrintf: lines.has("findPrintf"),
    statC: lines.has("statC"),
    tools,
  };
  if (caps.exec) {
    if (tarFlavor) caps.tarFlavor = tarFlavor;
    caps.appendSupport = computeAppendSupport(tools, tarFlavor);
    caps.deleteSupport = computeDeleteSupport(tools, tarFlavor);
  }
  return caps;
}

export async function getCapabilities(
  session: ContainerSession,
  containerId: string,
  signal?: AbortSignal,
  options: { fresh?: boolean } = {},
): Promise<Capabilities> {
  const state = await getContainerState(session, containerId, {
    signal,
    fresh: options.fresh,
  });
  const key = `${state.id}:${state.running ? "up" : "down"}`;
  const cached = session.capabilities.get(key);
  if (cached) return cached;

  let caps: Capabilities;
  if (!state.running) {
    caps = {
      ...parseProbe("", false),
      status: state.status,
      ...classifyFailure(
        {
          running: false,
          status: state.status,
          stdout: "",
          stderr: "",
          code: null,
        },
        session.runtime,
      ),
    };
  } else {
    let outcome: ProbeOutcome;
    try {
      const result = await runCommand(
        session.client,
        execScriptCommand(session.runtime, containerId, PROBE_SCRIPT),
        { signal, timeoutMs: 15_000 },
      );
      outcome = {
        running: true,
        status: state.status,
        stdout: result.stdout.toString(),
        stderr: result.stderr,
        code: result.code,
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      outcome = {
        running: true,
        status: state.status,
        stdout: "",
        stderr: "",
        code: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    caps = parseProbe(outcome.stdout, true);
    caps.status = state.status;
    if (!caps.exec)
      Object.assign(caps, classifyFailure(outcome, session.runtime));
  }
  // A container that just started may not accept exec yet: don't pin that.
  if (!state.running || caps.exec) session.capabilities.set(key, caps);
  return caps;
}

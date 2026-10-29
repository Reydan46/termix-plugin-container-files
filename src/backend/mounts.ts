import { runCommand } from "./exec.js";
import { engineCommand } from "./shell-quote.js";
import type { ContainerSession } from "./sessions.js";

export type MountType = "bind" | "volume" | "tmpfs";

export interface ContainerMount {
  type: MountType;
  /** Host path (bind), volume name or empty (tmpfs). */
  source: string;
  /** Absolute path inside the container. */
  destination: string;
  readOnly: boolean;
  /** Volume name when the engine reports one. */
  name?: string;
}

const MOUNTS_TTL_MS = 5000;
const MAX_MOUNTS = 1000;

/** Reads a field by name, ignoring case (docker: `Source`, some podman builds: `source`). */
function field(raw: Record<string, unknown>, name: string): unknown {
  if (name in raw) return raw[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(raw)) {
    if (key.toLowerCase() === lower) return raw[key];
  }
  return undefined;
}

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

function readOnlyOf(raw: Record<string, unknown>): boolean {
  const rw = field(raw, "RW");
  if (typeof rw === "boolean") return !rw;
  if (rw === "true" || rw === "false") return rw === "false";
  // Podman builds without RW describe it in Mode or Options.
  const mode = field(raw, "Mode");
  const options = field(raw, "Options");
  const flags = [
    ...text(mode).split(","),
    ...(Array.isArray(options) ? options.map(text) : []),
  ].map((flag) => flag.trim());
  return flags.includes("ro");
}

/**
 * Parses the output of `inspect --format '{{json .Mounts}}'`. Anything that is
 * not a JSON array of mounts with an absolute destination yields an empty list.
 */
export function parseMounts(output: string): ContainerMount[] {
  let data: unknown;
  try {
    data = JSON.parse(output.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const mounts: ContainerMount[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const destination = text(field(raw, "Destination")).replace(
      /(.)\/+$/,
      "$1",
    );
    if (!destination.startsWith("/") || seen.has(destination)) continue;
    const name = text(field(raw, "Name"));
    const kind = text(field(raw, "Type")).toLowerCase();
    const type: MountType =
      kind === "bind" || kind === "volume" || kind === "tmpfs"
        ? kind
        : name
          ? "volume"
          : "bind";
    seen.add(destination);
    mounts.push({
      type,
      source: text(field(raw, "Source")) || (type === "volume" ? name : ""),
      destination,
      readOnly: readOnlyOf(raw),
      ...(name ? { name } : {}),
    });
    if (mounts.length >= MAX_MOUNTS) break;
  }
  return mounts;
}

/** Mounts of a container, cached briefly; the cache is dropped with the container state. */
export async function getMounts(
  session: ContainerSession,
  containerId: string,
  signal?: AbortSignal,
): Promise<ContainerMount[]> {
  const cached = session.mounts.get(containerId);
  if (cached && Date.now() - cached.at < MOUNTS_TTL_MS) return cached.mounts;
  const result = await runCommand(
    session.client,
    engineCommand(session.runtime, [
      "inspect",
      "--type",
      "container",
      "--format",
      "{{json .Mounts}}",
      containerId,
    ]),
    { signal, timeoutMs: 15_000 },
  );
  const mounts = result.code === 0 ? parseMounts(result.stdout.toString()) : [];
  session.mounts.set(containerId, { at: Date.now(), mounts });
  return mounts;
}

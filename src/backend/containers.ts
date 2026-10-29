import type { Client } from "ssh2";
import { runChecked, runCommand } from "./exec.js";
import { HttpError, CONTAINER_ID_RE } from "./helpers.js";
import { engineCommand, type ContainerRuntime } from "./shell-quote.js";
import type { ContainerSession } from "./sessions.js";

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  created: string;
}

export interface ContainerState {
  id: string;
  name: string;
  running: boolean;
  /** Engine status: running, paused, exited, created, restarting, ... */
  status: string;
}

const STATE_TTL_MS = 5000;

const LIST_FORMAT =
  '{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}","status":"{{.Status}}","state":"{{.State}}","ports":"{{.Ports}}","created":"{{.CreatedAt}}"}';

/** Parses `ps --format` output, skipping lines that are not JSON. */
export function parseContainerList(output: string): ContainerSummary[] {
  return output
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ContainerSummary];
      } catch {
        return [];
      }
    });
}

export async function listContainers(
  client: Client,
  runtime: ContainerRuntime,
  signal?: AbortSignal,
): Promise<ContainerSummary[]> {
  const out = await runChecked(
    client,
    engineCommand(runtime, ["ps", "-a", "--format", LIST_FORMAT]),
    { signal, timeoutMs: 30_000 },
  );
  return parseContainerList(out.toString());
}

/**
 * Parses `inspect --format '{{.Id}}|{{.State.Running}}|{{.State.Status}}|{{.Name}}'`.
 * The three-field form (no status) is still accepted.
 */
export function parseInspect(output: string): ContainerState | null {
  const parts = output.trim().split("|");
  const [id, running] = parts;
  if (!id || (running !== "true" && running !== "false")) return null;
  const hasStatus = parts.length >= 4;
  const status = hasStatus
    ? parts[2]
    : running === "true"
      ? "running"
      : "exited";
  const name = parts.slice(hasStatus ? 3 : 2).join("|");
  const finalStatus = status || (running === "true" ? "running" : "exited");
  return {
    id,
    // A paused container reports Running=true but cannot exec.
    running: running === "true" && finalStatus !== "paused",
    status: finalStatus,
    name: name.replace(/^\//, ""),
  };
}

/**
 * Validates the id and confirms the container exists on this host, returning
 * its state. Results are cached briefly so a burst of requests costs one call.
 */
export async function getContainerState(
  session: ContainerSession,
  containerId: string,
  options: { fresh?: boolean; signal?: AbortSignal } = {},
): Promise<ContainerState> {
  if (!CONTAINER_ID_RE.test(containerId)) {
    throw new HttpError(400, "Invalid container ID");
  }
  const cached = session.states.get(containerId);
  if (!options.fresh && cached && Date.now() - cached.at < STATE_TTL_MS) {
    return cached.state;
  }
  const result = await runCommand(
    session.client,
    engineCommand(session.runtime, [
      "inspect",
      "--type",
      "container",
      "--format",
      "{{.Id}}|{{.State.Running}}|{{.State.Status}}|{{.Name}}",
      containerId,
    ]),
    { signal: options.signal, timeoutMs: 15_000 },
  );
  const state =
    result.code === 0 ? parseInspect(result.stdout.toString()) : null;
  if (!state) {
    session.states.delete(containerId);
    throw new HttpError(404, "Container not found", "CONTAINER_NOT_FOUND");
  }
  session.states.set(containerId, { at: Date.now(), state });
  return state;
}

export const CONTAINER_ACTIONS = [
  "start",
  "stop",
  "restart",
  "pause",
  "unpause",
] as const;
export type ContainerAction = (typeof CONTAINER_ACTIONS)[number];

export function isContainerAction(value: unknown): value is ContainerAction {
  return (
    typeof value === "string" &&
    (CONTAINER_ACTIONS as readonly string[]).includes(value)
  );
}

/** Runs `<runtime> <action> <id>` and returns the fresh state. */
export async function runContainerAction(
  session: ContainerSession,
  containerId: string,
  action: ContainerAction,
  signal?: AbortSignal,
): Promise<ContainerState> {
  // Validates the id and that the container exists.
  await getContainerState(session, containerId, { fresh: true, signal });
  const result = await runCommand(
    session.client,
    engineCommand(session.runtime, [action, containerId]),
    { signal, timeoutMs: 120_000 },
  );
  invalidateContainerState(session, containerId);
  if (result.code !== 0) {
    throw new HttpError(
      500,
      result.stderr.trim() || `${action} failed with code ${result.code}`,
      "ACTION_FAILED",
    );
  }
  return getContainerState(session, containerId, { fresh: true, signal });
}

export function invalidateContainerState(
  session: ContainerSession,
  containerId: string,
): void {
  session.states.delete(containerId);
  session.mounts.delete(containerId);
}

import type { Client } from "ssh2";
import { runCommand } from "./exec.js";
import type { ContainerRuntime } from "./shell-quote.js";

const EXTRA_PATH =
  '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:"$HOME/.orbstack/bin"';

/** Picks the first of docker/podman found in `command -v` output. */
export function parseRuntime(output: string): ContainerRuntime | null {
  for (const line of output.split("\n")) {
    const base = line.trim().split("/").pop();
    if (base === "docker" || base === "podman") return base;
  }
  return null;
}

/** Engine version for the header, e.g. "29.0.1"; null when it can't be read. */
export async function detectRuntimeVersion(
  client: Client,
  runtime: ContainerRuntime,
): Promise<string | null> {
  const format = runtime === "podman" ? "{{.Version}}" : "{{.Server.Version}}";
  const result = await runCommand(
    client,
    `PATH="${EXTRA_PATH}:$PATH" ${runtime} version --format '${format}'`,
    { timeoutMs: 10_000 },
  );
  if (result.code !== 0) return null;
  const version = result.stdout.toString().split(/\r?\n/)[0]?.trim();
  return version && /^[\w.+~-]{1,40}$/.test(version) ? version : null;
}

/** Which container CLI the host has; docker wins when both are installed. */
export async function detectRuntime(
  client: Client,
): Promise<ContainerRuntime | null> {
  const result = await runCommand(
    client,
    `PATH="${EXTRA_PATH}:$PATH" sh -c 'command -v docker; command -v podman'`,
    { timeoutMs: 10_000 },
  );
  return parseRuntime(result.stdout.toString());
}

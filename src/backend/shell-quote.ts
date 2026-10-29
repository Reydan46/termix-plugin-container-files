import { posix } from "node:path";
import { HttpError } from "./helpers.js";

export type ContainerRuntime = "docker" | "podman";

const MAX_PATH = 4096;

/** Quotes one value for a POSIX shell. */
export function shq(value: string): string {
  if (value.includes("\0")) throw new HttpError(400, "Invalid argument");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Non-interactive SSH shells don't source login profiles, so installer PATH
 * additions (Homebrew, OrbStack) are missing.
 */
const EXTRA_PATH =
  '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:"$HOME/.orbstack/bin"';

/** `docker <args...>` with every argument quoted. */
export function engineCommand(
  runtime: ContainerRuntime,
  args: string[],
): string {
  return `PATH="${EXTRA_PATH}:$PATH" ${runtime} ${args.map(shq).join(" ")}`;
}

/**
 * Runs `script` in the container's `sh`. Values reach the script only as
 * positional parameters ($1, $2, ...), never through interpolation.
 */
export function execScriptCommand(
  runtime: ContainerRuntime,
  containerId: string,
  script: string,
  args: string[] = [],
  options: { interactive?: boolean } = {},
): string {
  return engineCommand(runtime, [
    "exec",
    ...(options.interactive ? ["-i"] : []),
    containerId,
    "sh",
    "-c",
    script,
    "_",
    ...args,
  ]);
}

/** An absolute, normalized path inside a container. */
export function safePath(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new HttpError(400, "Path is required");
  }
  if (value.includes("\0") || value.length > MAX_PATH) {
    throw new HttpError(400, "Invalid path");
  }
  const normalized = posix.normalize(
    value.startsWith("/") ? value : `/${value}`,
  );
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

/** A single file name: no separators, not . or .., no NUL. */
export function safeName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\0") ||
    value.length > 255
  ) {
    throw new HttpError(400, "Invalid file name");
  }
  return value;
}

/** A relative path made of safe names (for folder uploads). */
export function safeRelative(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new HttpError(400, "Invalid relative path");
  }
  const parts = value.split("/").filter((p) => p !== "" && p !== ".");
  if (!parts.length || parts.some((p) => p === ".." || p.length > 255)) {
    throw new HttpError(400, "Invalid relative path");
  }
  return parts.join("/");
}

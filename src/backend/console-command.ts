// Builds the command that runs an interactive shell inside a container. It is
// started with ssh2's exec (never typed into a host shell), but the host's
// login shell still parses it, so every value is validated and quoted.

import { CONTAINER_ID_RE, HttpError } from "./helpers.js";
import {
  engineCommand,
  safePath,
  type ContainerRuntime,
} from "./shell-quote.js";

/** Shell names that may be started by name (resolved by the container's PATH). */
export const CONSOLE_SHELL_NAMES = [
  "bash",
  "sh",
  "zsh",
  "ash",
  "dash",
  "fish",
  "ksh",
] as const;

/** Tries bash and falls back to sh. */
export const AUTO_SHELL = "auto";

// Absolute path made of plain path characters only (no spaces, quotes, "~",
// "$", backticks, globs or other shell syntax). It is quoted as well.
const SHELL_PATH_RE = /^(?:\/[A-Za-z0-9._+@-]+)+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const AUTO_SCRIPT = "command -v bash >/dev/null 2>&1 && exec bash || exec sh";

export function isShellPath(value: string): boolean {
  return (
    value.length <= 200 &&
    SHELL_PATH_RE.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

export function isConsoleShell(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === AUTO_SHELL ||
      (CONSOLE_SHELL_NAMES as readonly string[]).includes(value) ||
      isShellPath(value))
  );
}

/** The `exec -it` command for the container's shell started in `dir`. */
export function buildConsoleCommand(options: {
  runtime: ContainerRuntime;
  containerId: string;
  dir: unknown;
  shell: unknown;
}): string {
  const { runtime, containerId, shell } = options;
  if (runtime !== "docker" && runtime !== "podman")
    throw new HttpError(400, "Unsupported container runtime");
  if (!CONTAINER_ID_RE.test(containerId))
    throw new HttpError(400, "Invalid container id");
  if (!isConsoleShell(shell)) throw new HttpError(400, "Unsupported shell");
  const dir = safePath(options.dir);
  if (CONTROL_RE.test(dir)) throw new HttpError(400, "Invalid folder");
  const tail = shell === AUTO_SHELL ? ["sh", "-c", AUTO_SCRIPT] : [shell];
  return engineCommand(runtime, [
    "exec",
    "-it",
    "-w",
    dir,
    containerId,
    ...tail,
  ]);
}

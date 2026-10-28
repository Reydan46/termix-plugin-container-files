// Shell names and paths for the terminal picker. The backend validates them
// again before building the command (src/backend/console-command.ts).

/** Shells offered in the picker; "auto" tries bash and falls back to sh. */
export const TERMINAL_SHELLS = [
  "auto",
  "bash",
  "sh",
  "zsh",
  "ash",
  "dash",
  "fish",
  "ksh",
] as const;

/**
 * A shell name from the list above, "auto", or an absolute path inside the
 * container (for example /usr/local/bin/fish).
 */
export type TerminalShell = string;

const SHELL_RE = /^[a-z][a-z0-9]{1,7}$/;
// Absolute path built from plain path characters only: no spaces, quotes, "~",
// "$", backticks, globs or other shell syntax. It is quoted as well.
const SHELL_PATH_RE = /^(?:\/[A-Za-z0-9._+@-]+)+$/;

export function isShellPath(value: string): boolean {
  return (
    value.length <= 200 &&
    SHELL_PATH_RE.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

export function isTerminalShell(value: string): boolean {
  return (
    (SHELL_RE.test(value) &&
      (TERMINAL_SHELLS as readonly string[]).includes(value)) ||
    isShellPath(value)
  );
}

/** Preference order when no shell is chosen: the default, then these. */
const FALLBACK_ORDER = ["bash", "ash", "sh"];

/**
 * The shell to start without asking: the container default, else bash, ash or
 * sh from the shells found in it. Null when none is usable.
 */
export function pickShell(info: {
  shells: string[];
  default: string | null;
}): string | null {
  const usable = info.shells.filter(isShellPath);
  if (info.default && isShellPath(info.default)) return info.default;
  for (const name of FALLBACK_ORDER) {
    const found = usable.find((p) => p.split("/").pop() === name);
    if (found) return found;
  }
  return null;
}

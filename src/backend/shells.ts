import { runCommand } from "./exec.js";
import { execScriptCommand } from "./shell-quote.js";
import type { ListTarget } from "./fs-list.js";

export interface ShellInfo {
  /** Absolute paths of usable shells. */
  shells: string[];
  /** The shell of the user `docker exec` runs as, or null if unknown. */
  default: string | null;
}

const NO_SHELLS: ShellInfo = { shells: [], default: null };

/**
 * Constant script (no values are interpolated). Prints `shell:<path>` for every
 * executable listed in /etc/shells and found on PATH, `passwd:<path>` for the
 * current user's login shell and `env:<path>` for $SHELL.
 */
const SHELLS_SCRIPT = `if [ -r /etc/shells ]; then while IFS= read -r s; do case "$s" in /*) [ -x "$s" ] && echo "shell:$s";; esac; done < /etc/shells; fi
for c in bash zsh ash dash fish ksh sh; do p=$(command -v "$c" 2>/dev/null); case "$p" in /*) [ -x "$p" ] && echo "shell:$p";; esac; done
uid=$(id -u 2>/dev/null)
if [ -r /etc/passwd ] && [ -n "$uid" ]; then while IFS=: read -r n _ u _ _ _ s; do if [ "$u" = "$uid" ]; then [ -x "$s" ] && echo "passwd:$s"; break; fi; done < /etc/passwd; fi
[ -n "$SHELL" ] && [ -x "$SHELL" ] && echo "env:$SHELL"
exit 0`;

/** Shells that exist only to refuse a login. */
const REFUSING = /(^|\/)(nologin|false|true|git-shell)$/;

const usable = (path: string) =>
  path.startsWith("/") &&
  path.length <= 1024 &&
  !/[\0-\x1f\x7f\s]/.test(path) &&
  !REFUSING.test(path);

/** Parses SHELLS_SCRIPT output. */
export function parseShells(output: string): ShellInfo {
  const shells: string[] = [];
  let passwd: string | null = null;
  let env: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const kind = line.slice(0, i);
    const path = line.slice(i + 1).trim();
    if (!usable(path)) continue;
    if (kind === "shell" && !shells.includes(path)) shells.push(path);
    else if (kind === "passwd") passwd = path;
    else if (kind === "env") env = path;
  }
  const preferred = passwd ?? env;
  if (preferred && !shells.includes(preferred)) shells.push(preferred);
  return { shells, default: preferred };
}

/** Never throws: a stopped or shell-less container just has no shells. */
export async function listShells(
  target: ListTarget,
  signal?: AbortSignal,
): Promise<ShellInfo> {
  if (!target.capabilities.running || !target.capabilities.exec) {
    return NO_SHELLS;
  }
  try {
    const result = await runCommand(
      target.client,
      execScriptCommand(target.runtime, target.containerId, SHELLS_SCRIPT),
      { signal, timeoutMs: 15_000, maxBytes: 1024 * 1024 },
    );
    if (result.code !== 0) return NO_SHELLS;
    return parseShells(result.stdout.toString("utf8"));
  } catch {
    return NO_SHELLS;
  }
}

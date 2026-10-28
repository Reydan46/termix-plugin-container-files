import { posix } from "node:path";
import { cpReadFile, cpUpload } from "./cp-io.js";
import { runCommand } from "./exec.js";
import { errorFromResult, EXIT_CONFLICT, statPath } from "./fs-ops.js";
import type { ListTarget } from "./fs-list.js";
import { HttpError } from "./helpers.js";
import { execScriptCommand } from "./shell-quote.js";
import { packBuffer } from "./tar.js";

export const EDITOR_MAX_BYTES = 5 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

export interface TextFile {
  content: string;
  size: number;
  mtime: number;
  mode: number;
}

export async function readTextFile(
  t: ListTarget,
  path: string,
  signal?: AbortSignal,
): Promise<TextFile> {
  const entry = await statPath(t, path, { signal }).catch((e) => {
    // Without a shell the stat itself may be unavailable; let the read decide.
    if (e instanceof HttpError && e.code === "NO_EXEC") return null;
    throw e;
  });
  if (entry) {
    if (entry.type === "directory") {
      throw new HttpError(400, "Is a directory", "NOT_A_FILE");
    }
    if (entry.size > EDITOR_MAX_BYTES) {
      throw new HttpError(413, "File too large to edit", "TOO_LARGE");
    }
  }

  let data: Buffer;
  let mtime = entry?.mtime ?? 0;
  let mode = entry?.mode ?? 0o644;
  if (t.capabilities.exec) {
    const result = await runCommand(
      t.client,
      execScriptCommand(t.runtime, t.containerId, 'cat -- "$1"', [path]),
      { signal, maxBytes: EDITOR_MAX_BYTES, timeoutMs: 60_000 },
    );
    if (result.code !== 0) throw errorFromResult(result);
    data = result.stdout;
  } else {
    const file = await cpReadFile(t, path, EDITOR_MAX_BYTES, signal);
    data = file.data;
    mtime = file.mtime;
    mode = file.mode;
  }
  if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new HttpError(415, "Binary file", "BINARY");
  }
  return { content: data.toString("utf8"), size: data.length, mtime, mode };
}

const WRITE_SCRIPT = `p=$1
if [ -L "$p" ]; then r=$(readlink -f -- "$p" 2>/dev/null); [ -n "$r" ] && p=$r; fi
if [ -n "$2" ] && [ -e "$p" ]; then
  cur=$(stat -c %Y -- "$p" 2>/dev/null)
  if [ -n "$cur" ] && [ "$cur" != "$2" ]; then exit ${EXIT_CONFLICT}; fi
fi
d=$(dirname -- "$p")
t="$d/.cf-save.$$"
cat > "$t" || { rm -f -- "$t"; exit 1; }
if [ -e "$p" ]; then
  m=$(stat -c %a -- "$p" 2>/dev/null); o=$(stat -c %u:%g -- "$p" 2>/dev/null)
  [ -n "$m" ] && chmod "$m" "$t" 2>/dev/null
  [ -n "$o" ] && chown "$o" "$t" 2>/dev/null
fi
mv -f -- "$t" "$p" || { rm -f -- "$t"; exit 1; }`;

/**
 * Saves editor content. With a shell the write goes to a temp file next to the
 * target and is renamed over it (atomic, keeps mode/owner); `expectedMtime`
 * rejects the save when the file changed since it was opened. Without a shell
 * the file is replaced through `cp`, which cannot check or preserve anything.
 */
export async function writeTextFile(
  t: ListTarget,
  path: string,
  data: Buffer,
  expectedMtime: number | undefined,
  signal?: AbortSignal,
): Promise<{ size: number; mtime: number }> {
  if (data.length > EDITOR_MAX_BYTES) {
    throw new HttpError(413, "File too large to edit", "TOO_LARGE");
  }
  if (t.capabilities.exec) {
    const result = await runCommand(
      t.client,
      execScriptCommand(
        t.runtime,
        t.containerId,
        WRITE_SCRIPT,
        [path, expectedMtime === undefined ? "" : String(expectedMtime)],
        { interactive: true },
      ),
      { signal, stdin: data, timeoutMs: 60_000 },
    );
    if (result.code !== 0) throw errorFromResult(result);
  } else {
    const existing = await statPath(t, path, { signal }).catch(() => null);
    if (
      existing &&
      expectedMtime !== undefined &&
      existing.mtime !== expectedMtime
    ) {
      throw new HttpError(409, "File was modified", "CONFLICT");
    }
    await cpUpload(
      t,
      posix.dirname(path),
      packBuffer(posix.basename(path), data, { mode: existing?.mode }),
      signal,
    );
  }
  const after = await statPath(t, path, { signal }).catch(() => null);
  return { size: data.length, mtime: after?.mtime ?? 0 };
}

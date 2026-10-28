import { posix } from "node:path";
import { cpUpload } from "./cp-io.js";
import { openCpSource } from "./channel-stream.js";
import { runCommand } from "./exec.js";
import type { ListTarget } from "./fs-list.js";
import { HttpError, partName } from "./helpers.js";
import { execScriptCommand } from "./shell-quote.js";
import { sanitizeTar } from "./tar.js";
import { directoryOwner, moveIntoPlace, type Transfer } from "./transfers.js";

/** Total size of `paths` through `du -sb`; 0 when it can't be told. */
export async function duBytes(
  t: ListTarget,
  paths: string[],
  signal?: AbortSignal,
): Promise<number> {
  if (!t.capabilities.exec || paths.length === 0) return 0;
  try {
    const result = await runCommand(
      t.client,
      execScriptCommand(
        t.runtime,
        t.containerId,
        `du -sb -- "$@" 2>/dev/null`,
        paths,
      ),
      { signal, timeoutMs: 15_000 },
    );
    let sum = 0;
    for (const line of result.stdout.toString().split("\n")) {
      const n = Number(line.split("\t")[0]);
      if (Number.isFinite(n)) sum += n;
    }
    return sum;
  } catch (error) {
    if (signal?.aborted) throw error;
    return 0;
  }
}

export interface RelayParams {
  paths: string[];
  dir: string;
  /** Source top-level name -> target name (keep both). */
  renames?: Record<string, string>;
  /** Source top-level names to leave out. */
  skip?: string[];
}

export function ownRename(renames: Record<string, string> | undefined) {
  return (top: string) =>
    renames && Object.hasOwn(renames, top) ? renames[top] : top;
}

/**
 * Copies paths between two containers of one host by relaying the tar stream
 * through the backend: `cp src -` -> sanitize (owner, renames) -> `cp - dst`.
 * Cancelling the transfer destroys both SSH channels.
 */
export async function relayCopy(
  src: ListTarget,
  dst: ListTarget,
  transfer: Transfer,
  params: RelayParams,
): Promise<{ copied: number }> {
  const { signal } = transfer.controller;
  const skip = new Set(params.skip ?? []);
  const paths = params.paths.filter((p) => !skip.has(posix.basename(p)));
  for (const p of paths) {
    if (p === "/") throw new HttpError(400, "Cannot copy the root", "BAD_PATH");
    if (
      src.containerId === dst.containerId &&
      (params.dir === p || params.dir.startsWith(`${p}/`))
    ) {
      throw new HttpError(
        400,
        "Cannot copy a folder into itself",
        "COPY_INTO_SELF",
      );
    }
  }
  transfer.total = await duBytes(src, paths, signal);
  const owner = await directoryOwner(dst, params.dir, signal);
  const rename = ownRename(params.renames);

  // With a shell on the target, new names are written under a hidden temporary
  // name and renamed once the copy is complete, so a failed or cancelled copy
  // leaves no partial target. A name that already exists keeps the merge
  // semantics of `cp` (written in place).
  const useTemp = dst.capabilities.exec;
  const finals = paths.map((p) => rename(posix.basename(p)));
  const existing = useTemp
    ? await existingNames(dst, params.dir, finals, signal)
    : new Set<string>();

  for (const [i, path] of paths.entries()) {
    const top = posix.basename(path);
    const finalName = finals[i];
    const tempName =
      useTemp && !existing.has(finalName)
        ? partName(transfer.id, finalName)
        : null;
    const source = await openCpSource(
      src,
      path,
      (n) => (transfer.bytes += n),
      signal,
    );
    const onAbort = () => source.close();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await cpUpload(
        dst,
        params.dir,
        sanitizeTar(source.stream, {
          owner,
          rename: (name) =>
            name === top && tempName ? tempName : rename(name),
          allowHardlinks: true,
        }),
        signal,
      );
      if (tempName) {
        await moveIntoPlace(
          dst,
          posix.join(params.dir, tempName),
          posix.join(params.dir, finalName),
          false,
        );
      }
    } catch (error) {
      if (tempName) await removeTree(dst, posix.join(params.dir, tempName));
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      source.close();
    }
  }
  return { copied: paths.length };
}

/** Which of `names` already exist in `dir` (when the probe fails, all are assumed to). */
async function existingNames(
  t: ListTarget,
  dir: string,
  names: string[],
  signal: AbortSignal,
): Promise<Set<string>> {
  try {
    const result = await runCommand(
      t.client,
      execScriptCommand(
        t.runtime,
        t.containerId,
        `d="$1"; shift; for n; do if [ -e "$d/$n" ] || [ -L "$d/$n" ]; then printf '%s\\0' "$n"; fi; done`,
        [dir, ...names],
      ),
      { signal, timeoutMs: 15_000 },
    );
    if (result.code !== 0) return new Set(names);
    return new Set(result.stdout.toString().split("\0").filter(Boolean));
  } catch (error) {
    if (signal.aborted) throw error;
    return new Set(names);
  }
}

/** Best-effort removal of a half-written temporary copy. */
async function removeTree(t: ListTarget, path: string): Promise<void> {
  await runCommand(
    t.client,
    execScriptCommand(t.runtime, t.containerId, `rm -rf -- "$1"`, [path]),
    { timeoutMs: 30_000 },
  ).catch(() => {});
}

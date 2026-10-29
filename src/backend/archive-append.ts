import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { runCommand } from "./exec.js";
import { errorFromResult, requireExec } from "./fs-ops.js";
import type { OpOptions } from "./fs-ops.js";
import type { ListTarget } from "./fs-list.js";
import { HttpError, partName } from "./helpers.js";
import { execScriptCommand } from "./shell-quote.js";
import { archiveKind, type ArchiveKind } from "./archive.js";
import { firstTool, isSingleFile, SEVENZ_TOOLS } from "./archive-kinds.js";
import {
  parseWcBytes,
  probe,
  probeSize,
  watchProgress,
} from "./op-progress.js";

/**
 * Adds files and folders to an archive that already sits in the container.
 *
 * Nothing touches the original until the result is complete: the work happens
 * on `.cf-part-` files next to the archive and the finished file is moved over
 * it with one `mv` (same folder, so atomic). zip is updated with `zip -g` and
 * plain tar with `tar -r`, both on a copy. Compressed tars cannot be appended
 * to in place: they are decompressed to a temporary tar, appended to and
 * compressed again (a full rewrite, but still atomic). 7z is updated with
 * `7z a` on a copy. rar and single compressed files cannot be added to.
 * Anything the container's tools cannot do fails with APPEND_UNSUPPORTED and a
 * `reason`.
 */

/** Exit codes of APPEND_SCRIPT for the conditions it reports itself. */
const EXIT_BUSYBOX_TAR = 19;
const EXIT_NO_COMPRESSOR = 20;
const EXIT_READ_ONLY = 21;
const EXIT_SYMLINK = 23;
const EXIT_ZIP_NOTHING = 12;

const APPEND_TIMEOUT_MS = 30 * 60 * 1000;

export type AppendUnsupportedReason =
  | "busybox-tar"
  | "no-compressor"
  | "symlink"
  | "format"
  | "rar"
  | "single-file";

/**
 * Archive kinds that can be appended to, and the tool each one needs ("7z"
 * stands for any 7-Zip build).
 */
export const APPEND_TOOLS: Partial<Record<ArchiveKind, "zip" | "tar" | "7z">> =
  {
    zip: "zip",
    tar: "tar",
    tgz: "tar",
    tbz: "tar",
    txz: "tar",
    tzst: "tar",
    "7z": "7z",
  };

const COMPRESSOR: Partial<Record<ArchiveKind, string>> = {
  tgz: "gzip",
  tbz: "bzip2",
  txz: "xz",
  tzst: "zstd",
};

export const REASON_TEXT: Record<AppendUnsupportedReason, string> = {
  "busybox-tar":
    "this container's tar (BusyBox) cannot append to an archive; use GNU tar",
  "no-compressor":
    "the compression tool this archive needs is not installed in the container",
  symlink: "the archive is a symbolic link; choose the file it points to",
  format: "this archive type cannot be appended to",
  rar: "RAR archives can be opened and extracted but not changed (the format is closed and has no free writer)",
  "single-file":
    "this is one compressed file, not an archive of several; extract it first",
};

/** Why an archive of this kind cannot be changed at all, if it cannot. */
export function readOnlyReason(
  kind: ArchiveKind,
): "rar" | "single-file" | undefined {
  if (kind === "rar") return "rar";
  return isSingleFile(kind) ? "single-file" : undefined;
}

/** `tool` names the missing program for "no-compressor". */
export function unsupported(
  reason: AppendUnsupportedReason,
  tool?: string,
): HttpError {
  const text =
    reason === "no-compressor" && tool
      ? `${tool} is not installed in the container, and this archive needs it`
      : REASON_TEXT[reason];
  return new HttpError(
    501,
    `Cannot add to this archive: ${text}`,
    "APPEND_UNSUPPORTED",
    tool ? { reason, tool } : { reason },
  );
}

/**
 * Arguments: archive, kind, work file, scratch tar, source folder, tool for
 * compressed kinds, then the source names. The cleanup trap also runs on
 * SIGHUP/SIGTERM, which is what a closed channel delivers.
 */
const APPEND_SCRIPT = `a=$1; kind=$2; w=$3; x=$4; d=$5; c=$6; shift 6
cleanup() { rm -f -- "$w"; if [ -n "$x" ]; then rm -f -- "$x"; fi; }
trap cleanup EXIT
trap 'exit 143' HUP INT TERM
if [ -L "$a" ]; then exit ${EXIT_SYMLINK}; fi
if [ ! -f "$a" ]; then echo "$a: No such file or directory" >&2; exit 1; fi
if [ ! -w "$a" ] || [ ! -w "$(dirname -- "$a")" ]; then exit ${EXIT_READ_ONLY}; fi
cd -- "$d" || exit 1
for n in "$@"; do
  if [ ! -e "$n" ] && [ ! -L "$n" ]; then
    echo "$d/$n: No such file or directory" >&2
    exit 1
  fi
done
case "$kind" in
  zip|7z) ;;
  *) case "$(tar --help 2>&1)" in *[Bb]usy[Bb]ox*) exit ${EXIT_BUSYBOX_TAR} ;; esac ;;
esac
m=$(stat -c %a -- "$a" 2>/dev/null)
o=$(stat -c %u:%g -- "$a" 2>/dev/null)
case "$kind" in
  zip)
    cp -p -- "$a" "$w" || exit 1
    zip -qgr "$w" -- "$@"; r=$?
    if [ "$r" != 0 ] && [ "$r" != ${EXIT_ZIP_NOTHING} ]; then exit "$r"; fi ;;
  tar)
    cp -p -- "$a" "$w" || exit 1
    tar -rf "$w" -- "$@" || exit $? ;;
  7z)
    cp -p -- "$a" "$w" || exit 1
    "$c" a -y -- "$w" "$@" </dev/null >/dev/null || exit $? ;;
  *)
    command -v "$c" >/dev/null 2>&1 || exit ${EXIT_NO_COMPRESSOR}
    "$c" -dc -- "$a" > "$x" || exit $?
    tar -rf "$x" -- "$@" || exit $?
    "$c" -c -- "$x" > "$w" || exit $?
    rm -f -- "$x" ;;
esac
if [ -n "$m" ]; then chmod "$m" -- "$w" 2>/dev/null; fi
if [ -n "$o" ]; then chown "$o" -- "$w" 2>/dev/null; fi
mv -f -- "$w" "$a"`;

/** Whether `name` is an archive type the append op accepts. */
export function canAppendTo(name: string): boolean {
  const kind = archiveKind(name);
  return kind !== null && kind in APPEND_TOOLS;
}

/** The temporary files used for `archive`: the work file and the scratch tar. */
export function appendTempPaths(
  archive: string,
  kind: ArchiveKind,
  id: string = randomUUID(),
): { work: string; scratch: string } {
  const dir = posix.dirname(archive);
  const base = posix.basename(archive);
  return {
    work: posix.join(dir, partName(id, base)),
    // 7-Zip builds its result in "<work>.tmp" first.
    scratch: COMPRESSOR[kind]
      ? posix.join(dir, partName(id, `${base}.tar`))
      : kind === "7z"
        ? `${posix.join(dir, partName(id, base))}.tmp`
        : "",
  };
}

/** Refuses sources that are, contain or are inside the archive itself. */
export function checkSources(
  dir: string,
  names: string[],
  archive: string,
): void {
  for (const name of names) {
    const src = posix.join(dir, name);
    if (src === archive || src === "/" || archive.startsWith(`${src}/`)) {
      throw new HttpError(
        400,
        "The archive cannot be added to itself",
        "INCLUDES_ARCHIVE",
      );
    }
  }
}

/** Adds `names` (relative to `dir`) to the existing archive at `archive`. */
export async function appendToArchive(
  t: ListTarget,
  archive: string,
  dir: string,
  names: string[],
  o: OpOptions = {},
): Promise<void> {
  if (!names.length) throw new HttpError(400, "Nothing to add");
  const kind = archiveKind(archive);
  if (!kind) throw unsupported("format");
  const fixed = readOnlyReason(kind);
  if (fixed) throw unsupported(fixed);
  checkSources(dir, names, archive);
  requireExec(t);
  const tool = APPEND_TOOLS[kind];
  if (!tool) throw unsupported("format");
  // 7z gets its binary from the probe: 7zz, 7z, 7za and 7zr all do.
  const sevenZ = firstTool(t.capabilities.tools, SEVENZ_TOOLS);
  if (kind === "7z" ? !sevenZ : !t.capabilities.tools.includes(tool)) {
    throw new HttpError(
      501,
      `${tool} is not installed in this container`,
      "NO_TOOL",
      { tool },
    );
  }
  if (kind === "7z") checkSevenZNames(names);
  const { work, scratch } = appendTempPaths(archive, kind);
  const progress = o.progress;
  progress?.setStage("preparing");
  let stopWatching: (() => void) | undefined;
  try {
    if (progress) {
      progress.setStage("scanning");
      progress.setTotal(await probeSize(t, dir, names, o.signal), true);
      // Only uncompressed work files grow in step with the sources.
      if (!COMPRESSOR[kind]) {
        const size = async (p: string) =>
          parseWcBytes((await probe(t, `wc -c < "$1"`, [p], o.signal)) ?? "");
        const baseline = (await size(archive)) ?? 0;
        progress.setStage("packing");
        stopWatching = watchProgress(progress, async () => {
          const now = await size(work);
          return now === undefined ? undefined : Math.max(0, now - baseline);
        });
      } else {
        progress.setTotal(undefined);
        progress.setStage("packing");
      }
    }
    const result = await runCommand(
      t.client,
      execScriptCommand(t.runtime, t.containerId, APPEND_SCRIPT, [
        archive,
        kind,
        work,
        scratch,
        dir,
        COMPRESSOR[kind] ?? (kind === "7z" ? sevenZ! : ""),
        ...names,
      ]),
      { signal: o.signal, timeoutMs: APPEND_TIMEOUT_MS },
    );
    stopWatching?.();
    if (result.code !== 0) throw appendError(result, kind);
    progress?.setStage("finishing");
  } catch (error) {
    // The script removes its own files; this covers a channel that died
    // before the trap ran (cancel, timeout, lost connection).
    await removeLeftovers(t, work, scratch);
    throw error;
  } finally {
    stopWatching?.();
  }
}

/** 7z reads source names as patterns (`*`, `?`, `@list`): refuse those. */
function checkSevenZNames(names: string[]): void {
  const bad = names.find((n) => /[*?]/.test(n) || n.startsWith("@"));
  if (bad !== undefined) {
    throw new HttpError(
      400,
      `"${bad}" cannot be added to a 7z archive: its name contains * or ? or starts with @`,
      "UNSUPPORTED_NAME",
    );
  }
}

function appendError(
  result: Parameters<typeof errorFromResult>[0],
  kind: ArchiveKind,
): HttpError {
  switch (result.code) {
    case EXIT_BUSYBOX_TAR:
      return unsupported("busybox-tar");
    case EXIT_NO_COMPRESSOR:
      return unsupported("no-compressor", COMPRESSOR[kind]);
    case EXIT_SYMLINK:
      return unsupported("symlink");
    case EXIT_READ_ONLY:
      return new HttpError(
        403,
        "The archive or its folder is read-only for this user",
        "ARCHIVE_READ_ONLY",
      );
    default:
      // zip exits with 18 when it cannot open a source; errorFromResult would
      // read that as "file was modified".
      return errorFromResult(
        result.code === 18 ? { ...result, code: 1 } : result,
      );
  }
}

/** Best-effort removal of the temp files; never throws, ignores cancel. */
export async function removeLeftovers(
  t: ListTarget,
  work: string,
  scratch: string,
): Promise<void> {
  try {
    await runCommand(
      t.client,
      execScriptCommand(
        t.runtime,
        t.containerId,
        `rm -f -- "$1"; if [ -n "$2" ]; then rm -f -- "$2"; fi`,
        [work, scratch],
      ),
      { timeoutMs: 60_000 },
    );
  } catch {
    /* nothing more to do */
  }
}

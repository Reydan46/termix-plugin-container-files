import { runCommand } from "./exec.js";
import { errorFromResult, requireExec } from "./fs-ops.js";
import type { OpOptions } from "./fs-ops.js";
import type { ListTarget } from "./fs-list.js";
import { HttpError } from "./helpers.js";
import { execScriptCommand } from "./shell-quote.js";
import {
  loadEntries,
  REL_FN,
  resolveMembers,
  type ArchiveEntry,
} from "./archive.js";
import {
  appendTempPaths,
  readOnlyReason,
  REASON_TEXT,
  removeLeftovers,
  type AppendUnsupportedReason,
} from "./archive-append.js";
import {
  archiveKind,
  firstTool,
  matchesPatterns,
  SEVENZ_TOOLS,
  type ArchiveKind,
} from "./archive-kinds.js";

/**
 * Deletes entries (files and whole folders) from an archive in the container.
 *
 * Like the append, nothing touches the original until the result is complete:
 * the work happens on a `.cf-part-` copy next to the archive and the finished
 * file is moved over it with one `mv`. zip uses `zip -d`, plain tar GNU
 * `tar --delete`, compressed tars are decompressed, edited and compressed
 * again, 7z uses `7z d`. BusyBox tar cannot delete; rar cannot be changed.
 * Anything the container's tools cannot do fails with DELETE_UNSUPPORTED and a
 * `reason`.
 */

const EXIT_NOT_GNU_TAR = 19;
const EXIT_NO_COMPRESSOR = 20;
const EXIT_READ_ONLY = 21;
const EXIT_SYMLINK = 23;
const EXIT_EMPTY = 24;
const EXIT_ZIP_NOTHING = 12;

const DELETE_TIMEOUT_MS = 30 * 60 * 1000;
const DELETE_MAX_ENTRIES = 500;

export type DeleteUnsupportedReason =
  Exclude<AppendUnsupportedReason, "busybox-tar"> | "gnu-tar";

const DELETE_REASON_TEXT: Record<DeleteUnsupportedReason, string> = {
  ...REASON_TEXT,
  "gnu-tar":
    "this container's tar is not GNU tar and cannot delete entries from an archive",
  format: "this archive type cannot be changed",
};

/** `tool` names the missing program for "no-compressor". */
export function deleteUnsupported(
  reason: DeleteUnsupportedReason,
  tool?: string,
): HttpError {
  const text =
    reason === "no-compressor" && tool
      ? `${tool} is not installed in the container, and this archive needs it`
      : DELETE_REASON_TEXT[reason];
  return new HttpError(
    501,
    `Cannot delete from this archive: ${text}`,
    "DELETE_UNSUPPORTED",
    tool ? { reason, tool } : { reason },
  );
}

/**
 * Arguments: archive, kind, work file, scratch file, tool (compressor or 7z
 * binary), then the stored member names. The cleanup trap also runs on
 * SIGHUP/SIGTERM, which is what a closed channel delivers.
 */
export const DELETE_SCRIPT = `a=$1; kind=$2; w=$3; x=$4; c=$5; shift 5
cleanup() { rm -f -- "$w"; if [ -n "$x" ]; then rm -f -- "$x"; fi; }
trap cleanup EXIT
trap 'exit 143' HUP INT TERM
if [ -L "$a" ]; then exit ${EXIT_SYMLINK}; fi
if [ ! -f "$a" ]; then echo "$a: No such file or directory" >&2; exit 1; fi
if [ ! -w "$a" ] || [ ! -w "$(dirname -- "$a")" ]; then exit ${EXIT_READ_ONLY}; fi
case "$kind" in
  zip|7z) ;;
  *) case "$(tar --version 2>&1)" in *GNU*) ;; *) exit ${EXIT_NOT_GNU_TAR} ;; esac ;;
esac
${REL_FN}
m=$(stat -c %a -- "$a" 2>/dev/null)
o=$(stat -c %u:%g -- "$a" 2>/dev/null)
case "$kind" in
  zip)
    cp -p -- "$a" "$w" || exit 1
    n=$#
    for p in "$@"; do r=$(rel "$p"); set -- "$@" "$r" "$r/" "$r/*"; done
    shift "$n"
    zip -q -d "$w" -- "$@"; r=$?
    if [ "$r" != 0 ]; then exit "$r"; fi ;;
  tar)
    cp -p -- "$a" "$w" || exit 1
    tar --delete --no-wildcards -f "$w" -- "$@" || exit $? ;;
  7z)
    cp -p -- "$a" "$w" || exit 1
    "$c" d -y -- "$w" "$@" </dev/null >/dev/null || exit $? ;;
  *)
    command -v "$c" >/dev/null 2>&1 || exit ${EXIT_NO_COMPRESSOR}
    "$c" -dc -- "$a" > "$x" || exit $?
    tar --delete --no-wildcards -f "$x" -- "$@" || exit $?
    "$c" -c -- "$x" > "$w" || exit $?
    rm -f -- "$x" ;;
esac
if [ ! -e "$w" ]; then exit ${EXIT_EMPTY}; fi
if [ -n "$m" ]; then chmod "$m" -- "$w" 2>/dev/null; fi
if [ -n "$o" ]; then chown "$o" -- "$w" 2>/dev/null; fi
mv -f -- "$w" "$a"`;

const DELETE_COMPRESSOR: Partial<Record<ArchiveKind, string>> = {
  tgz: "gzip",
  tbz: "bzip2",
  txz: "xz",
  tzst: "zstd",
};

/** Whether entries can be deleted from archives of this kind (tools allowing). */
export function canDeleteFrom(kind: ArchiveKind | null): boolean {
  return (
    kind !== null &&
    (kind === "zip" ||
      kind === "tar" ||
      kind === "7z" ||
      kind in DELETE_COMPRESSOR)
  );
}

/** zip reads member names as wildcard patterns (`* ? [`); refuse those. */
function checkPatternNames(kind: ArchiveKind, members: string[]): void {
  const bad = members.find((m) =>
    kind === "zip"
      ? /[*?[\\]/.test(m)
      : matchesPatterns(kind) && /[*?]/.test(m),
  );
  if (bad !== undefined) {
    throw new HttpError(
      400,
      `"${bad}" cannot be deleted: its name contains characters the archive tool reads as a pattern`,
      "UNSUPPORTED_NAME",
    );
  }
}

/** The entries left when the chosen paths (and what is inside them) go. */
function remainingEntries(
  entries: ArchiveEntry[],
  chosen: string[],
): ArchiveEntry[] {
  return entries.filter(
    (e) => !chosen.some((p) => e.path === p || e.path.startsWith(`${p}/`)),
  );
}

/**
 * Deletes the chosen archive paths (files and folders, with their contents)
 * from the archive at `archive`.
 */
export async function deleteFromArchive(
  t: ListTarget,
  archive: string,
  chosen: string[],
  o: OpOptions = {},
): Promise<void> {
  if (!chosen.length) throw new HttpError(400, "Nothing to delete");
  if (chosen.length > DELETE_MAX_ENTRIES) {
    throw new HttpError(400, "Too many entries to delete at once");
  }
  const kind = archiveKind(archive);
  if (!kind) throw new HttpError(400, "Unsupported archive type");
  const fixed = readOnlyReason(kind);
  if (fixed) throw deleteUnsupported(fixed);
  requireExec(t);
  const caps = t.capabilities;
  const compressor = DELETE_COMPRESSOR[kind];
  const sevenZ = firstTool(caps.tools, SEVENZ_TOOLS);
  const needed = kind === "zip" ? "zip" : kind === "7z" ? "7z" : "tar";
  if (kind === "7z" ? !sevenZ : !caps.tools.includes(needed)) {
    throw new HttpError(
      501,
      `${needed} is not installed in this container`,
      "NO_TOOL",
      { tool: needed },
    );
  }
  if (
    kind !== "zip" &&
    kind !== "7z" &&
    (caps.tarFlavor === "busybox" || caps.tarFlavor === "bsd")
  ) {
    throw deleteUnsupported("gnu-tar");
  }
  if (compressor && !caps.tools.includes(compressor)) {
    throw deleteUnsupported("no-compressor", compressor);
  }
  const progress = o.progress;
  progress?.setStage("preparing");
  const cached = await loadEntries(t, archive, kind, o.signal);
  const paths = [...new Set(chosen)];
  const members = resolveMembers(cached.entries, paths, kind);
  checkPatternNames(kind, members);
  if (remainingEntries(cached.entries, paths).length === 0) {
    throw new HttpError(
      409,
      "Deleting these entries would leave the archive empty; delete the archive itself instead",
      "ARCHIVE_WOULD_BE_EMPTY",
    );
  }
  const { work, scratch } = appendTempPaths(archive, kind);
  try {
    progress?.setStage("rewriting");
    const result = await runCommand(
      t.client,
      execScriptCommand(t.runtime, t.containerId, DELETE_SCRIPT, [
        archive,
        kind,
        work,
        scratch,
        compressor ?? (kind === "7z" ? sevenZ! : ""),
        ...members,
      ]),
      { signal: o.signal, timeoutMs: DELETE_TIMEOUT_MS },
    );
    if (result.code !== 0) throw deleteError(result, compressor);
    progress?.setStage("finishing");
  } catch (error) {
    // The script removes its own files; this covers a channel that died
    // before the trap ran (cancel, timeout, lost connection).
    await removeLeftovers(t, work, scratch);
    throw error;
  }
}

function deleteError(
  result: Parameters<typeof errorFromResult>[0],
  compressor: string | undefined,
): HttpError {
  switch (result.code) {
    case EXIT_NOT_GNU_TAR:
      return deleteUnsupported("gnu-tar");
    case EXIT_NO_COMPRESSOR:
      return deleteUnsupported("no-compressor", compressor);
    case EXIT_SYMLINK:
      return deleteUnsupported("symlink");
    case EXIT_READ_ONLY:
      return new HttpError(
        403,
        "The archive or its folder is read-only for this user",
        "ARCHIVE_READ_ONLY",
      );
    case EXIT_EMPTY:
      return new HttpError(
        409,
        "Deleting these entries would leave the archive empty; delete the archive itself instead",
        "ARCHIVE_WOULD_BE_EMPTY",
      );
    case EXIT_ZIP_NOTHING:
      return new HttpError(
        404,
        "None of the chosen entries were found in the archive",
        "NOT_FOUND",
      );
    default:
      return errorFromResult(result);
  }
}

import { posix } from "node:path";
import { runCommand, type ExecResult } from "./exec.js";
import { HttpError } from "./helpers.js";
import {
  listViaCp,
  parseFindOutput,
  parseStatOutput,
  type FileEntry,
  type ListTarget,
} from "./fs-list.js";
import { execScriptCommand } from "./shell-quote.js";
import {
  archiveKind,
  extractTools,
  lowerName,
  missingGroup,
  PICK_FN,
  RAR_TOOLS,
  SEVENZ_TOOLS,
  ZIP_PATTERN,
} from "./archive-kinds.js";
import {
  parseDuKb,
  parseUnzipTotal,
  parseWcBytes,
  probe,
  probeSize,
  watchProgress,
  type OpProgress,
} from "./op-progress.js";

/** Exit codes the scripts below use for conditions the UI handles. */
const EXIT_EXISTS = 17;
const EXIT_CONFLICT = 18;

const OP_TIMEOUT_MS = 10 * 60 * 1000;
const MODE_RE = /^[0-7]{3,4}$/;
const OWNER_RE = /^[A-Za-z0-9_.-]*(:[A-Za-z0-9_.-]*)?$/;

const STAT_FIND = `find -H "$1" -maxdepth 0 -printf '%f\\0%y\\0%s\\0%T@\\0%m\\0%u\\0%g\\0%l\\0%Y\\0'`;
const STAT_BUSYBOX = `stat -L -c '%F|%s|%Y|%a|%U|%G|%n' -- "$1"`;

export function requireExec(target: ListTarget): void {
  if (!target.capabilities.exec) {
    throw new HttpError(
      501,
      target.capabilities.running
        ? "This container has no shell, so this action is not available"
        : "Start the container to use this action",
      "NO_EXEC",
    );
  }
}

/** Turns a failed script into the HTTP error the UI expects. */
export function errorFromResult(result: ExecResult): HttpError {
  if (result.code === EXIT_EXISTS) {
    return new HttpError(409, "Already exists", "EXISTS");
  }
  if (result.code === EXIT_CONFLICT) {
    return new HttpError(409, "File was modified", "CONFLICT");
  }
  const text = result.stderr.trim();
  // "sh: tar: not found" means a missing tool, not a missing path.
  if (/: (\S+: )?not found$/im.test(text)) {
    return new HttpError(501, text, "NO_TOOL");
  }
  if (/no such file|cannot stat/i.test(text)) {
    const first = text.split(/\r?\n/)[0];
    return new HttpError(404, `Not found: ${first}`, "NOT_FOUND");
  }
  if (/permission denied|operation not permitted/i.test(text)) {
    return new HttpError(403, "Permission denied", "PERMISSION_DENIED");
  }
  if (/read-only file system/i.test(text)) {
    return new HttpError(403, "Read-only file system", "READ_ONLY");
  }
  if (/no space left/i.test(text)) {
    return new HttpError(507, "No space left on device", "NO_SPACE");
  }
  return new HttpError(
    500,
    text || `Command exited with code ${result.code}`,
    "EXEC_FAILED",
  );
}

async function run(
  target: ListTarget,
  script: string,
  args: string[],
  options: { signal?: AbortSignal; stdin?: Buffer | string } = {},
): Promise<ExecResult> {
  requireExec(target);
  const result = await runCommand(
    target.client,
    execScriptCommand(target.runtime, target.containerId, script, args, {
      interactive: options.stdin !== undefined,
    }),
    { signal: options.signal, stdin: options.stdin, timeoutMs: OP_TIMEOUT_MS },
  );
  if (result.code !== 0) throw errorFromResult(result);
  return result;
}

export interface OpOptions {
  signal?: AbortSignal;
  /** Receives the stage and byte counts of compress / extract. */
  progress?: OpProgress;
}

export async function makeDirectory(
  t: ListTarget,
  path: string,
  o: OpOptions = {},
): Promise<void> {
  await run(
    t,
    `if [ -e "$1" ] || [ -L "$1" ]; then exit ${EXIT_EXISTS}; fi; mkdir -- "$1"`,
    [path],
    o,
  );
}

export async function createFile(
  t: ListTarget,
  path: string,
  o: OpOptions = {},
): Promise<void> {
  await run(
    t,
    `if [ -e "$1" ] || [ -L "$1" ]; then exit ${EXIT_EXISTS}; fi; : > "$1"`,
    [path],
    o,
  );
}

function refuseRoot(path: string): void {
  if (path === "/") throw new HttpError(400, "Refusing to modify /");
}

/** Moves or renames; fails with EXISTS unless `overwrite`. */
export async function movePath(
  t: ListTarget,
  from: string,
  to: string,
  overwrite: boolean,
  o: OpOptions = {},
): Promise<void> {
  refuseRoot(from);
  refuseRoot(to);
  if (to === from || to.startsWith(`${from}/`)) {
    throw new HttpError(400, "Cannot move into itself");
  }
  if (from.startsWith(`${to}/`)) {
    throw new HttpError(400, "Cannot replace a parent folder");
  }
  await run(
    t,
    `if [ "$3" != 1 ] && { [ -e "$2" ] || [ -L "$2" ]; }; then exit ${EXIT_EXISTS}; fi; if [ "$3" = 1 ]; then rm -rf -- "$2"; fi; mv -f -- "$1" "$2"`,
    [from, to, overwrite ? "1" : "0"],
    o,
  );
}

export async function copyPath(
  t: ListTarget,
  from: string,
  to: string,
  overwrite: boolean,
  o: OpOptions = {},
): Promise<void> {
  refuseRoot(to);
  if (to === from || to.startsWith(`${from}/`)) {
    throw new HttpError(400, "Cannot copy into itself");
  }
  if (from.startsWith(`${to}/`)) {
    throw new HttpError(400, "Cannot replace a parent folder");
  }
  await run(
    t,
    `if [ "$3" != 1 ] && { [ -e "$2" ] || [ -L "$2" ]; }; then exit ${EXIT_EXISTS}; fi; if [ "$3" = 1 ]; then rm -rf -- "$2"; fi; cp -a -- "$1" "$2"`,
    [from, to, overwrite ? "1" : "0"],
    o,
  );
}

export async function deletePaths(
  t: ListTarget,
  paths: string[],
  o: OpOptions = {},
): Promise<void> {
  if (!paths.length) return;
  paths.forEach(refuseRoot);
  await run(t, `rm -rf -- "$@"`, paths, o);
}

/** What a recursive chmod/chown touches: everything, only files, only folders. */
export type ApplyScope = "all" | "files" | "dirs";

/** The `scope` request field; anything unknown means everything. */
export function parseScope(value: unknown): ApplyScope {
  return value === "files" || value === "dirs" ? value : "all";
}

const SCOPE_ARG: Record<ApplyScope, string> = {
  all: "a",
  files: "f",
  dirs: "d",
};

/**
 * Shell function `apply <value>` running `<tool>` on $P (the path) with
 * $R (recursive, "1") and $S (scope a|f|d) from the positional arguments.
 * A scoped run goes through find -depth with one path per call (children
 * before their folder, so removing x from a folder cannot block the walk) so only files (or only folders) are
 * touched, the path itself included; nothing is followed through links.
 */
const applyFn = (tool: "chmod" | "chown") =>
  [
    'P="$1"; R="$3"; S="$4"',
    "apply() {",
    '  case "$R$S" in',
    `    1f) find "$P" -depth -type f -exec ${tool} "$1" -- {} \; ;;`,
    `    1d) find "$P" -depth -type d -exec ${tool} "$1" -- {} \; ;;`,
    `    1*) ${tool} -R "$1" -- "$P" ;;`,
    `    *) ${tool} "$1" -- "$P" ;;`,
    "  esac",
    "}",
  ].join("\n");

export async function changeMode(
  t: ListTarget,
  path: string,
  mode: string,
  recursive: boolean,
  scope: ApplyScope = "all",
  o: OpOptions = {},
): Promise<void> {
  if (!MODE_RE.test(mode)) throw new HttpError(400, "Invalid mode");
  await run(
    t,
    // GNU chmod keeps setuid/setgid on directories for numeric modes shorter
    // than 5 digits, so a 4-digit mode clears the special bits it leaves out
    // explicitly (symbolic mode).
    [
      applyFn("chmod"),
      'apply "$2" || exit $?',
      's=""',
      'case "$2" in [0-7][0-7][0-7][0-7])',
      "  d=$((${2%???}))",
      '  [ $((d & 4)) = 0 ] && s="$s,u-s"',
      '  [ $((d & 2)) = 0 ] && s="$s,g-s"',
      '  [ $((d & 1)) = 0 ] && s="$s,o-t"',
      ";; esac",
      'if [ -n "$s" ]; then apply "${s#,}"; fi',
    ].join("\n"),
    [path, mode, recursive ? "1" : "0", SCOPE_ARG[scope]],
    o,
  );
}

export async function changeOwner(
  t: ListTarget,
  path: string,
  owner: string,
  recursive: boolean,
  scope: ApplyScope = "all",
  o: OpOptions = {},
): Promise<void> {
  if (!owner || !OWNER_RE.test(owner)) {
    throw new HttpError(400, "Invalid owner");
  }
  await run(
    t,
    [applyFn("chown"), 'apply "$2"'].join("\n"),
    [path, owner, recursive ? "1" : "0", SCOPE_ARG[scope]],
    o,
  );
}

/**
 * Creates a symbolic link `linkPath` -> `target` (any non-empty string, it may
 * be relative). Fails with EXISTS when the path is taken. With `force` an
 * existing symlink is retargeted (`ln -sfn`, so a link to a folder is replaced
 * rather than followed); anything else that exists is never replaced.
 */
export async function makeSymlink(
  t: ListTarget,
  target: string,
  linkPath: string,
  force = false,
  o: OpOptions = {},
): Promise<void> {
  if (!target || target.includes("\0")) {
    throw new HttpError(400, "target is required");
  }
  refuseRoot(linkPath);
  await run(
    t,
    `if [ -e "$2" ] || [ -L "$2" ]; then if [ "$3" = 1 ] && [ -L "$2" ]; then ln -sfn -- "$1" "$2"; exit $?; fi; exit ${EXIT_EXISTS}; fi; ln -s -- "$1" "$2"`,
    [target, linkPath, force ? "1" : "0"],
    o,
  );
}

export type ArchiveFormat = "tar" | "tgz" | "zip";

/** Packs `names` (relative to `dir`) into the archive at `out`. */
export async function compress(
  t: ListTarget,
  dir: string,
  names: string[],
  out: string,
  format: ArchiveFormat,
  o: OpOptions = {},
): Promise<void> {
  if (!names.length) throw new HttpError(400, "Nothing to compress");
  if (format === "zip" && !t.capabilities.tools.includes("zip")) {
    throw new HttpError(
      501,
      "zip is not installed in this container",
      "NO_TOOL",
    );
  }
  if (format !== "zip" && !t.capabilities.tools.includes("tar")) {
    throw new HttpError(
      501,
      "tar is not installed in this container",
      "NO_TOOL",
    );
  }
  const progress = o.progress;
  progress?.setStage("preparing");
  // Checked up front, so that a failure later on means this run made the file.
  await run(t, EXISTS_CHECK, [out], o);
  let stopWatching: (() => void) | undefined;
  try {
    if (progress) {
      progress.setStage("scanning");
      // The packed size is only guessed from the sources: labelled approximate.
      progress.setTotal(
        await probeSize(t, dir, names, o.signal),
        format !== "tar",
      );
      progress.setStage("packing");
      stopWatching = watchProgress(progress, async () =>
        parseWcBytes((await probe(t, `wc -c < "$1"`, [out], o.signal)) ?? ""),
      );
    }
    await run(
      t,
      `d=$1; out=$2; fmt=$3; shift 3
if [ -e "$out" ] || [ -L "$out" ]; then exit ${EXIT_EXISTS}; fi
cd -- "$d" || exit 1
for n in "$@"; do
  if [ ! -e "$n" ] && [ ! -L "$n" ]; then
    echo "$d/$n: No such file or directory" >&2
    exit 1
  fi
done
case "$fmt" in
  zip) zip -qr "$out" -- "$@" ;;
  tgz) tar -czf "$out" -- "$@" ;;
  *) tar -cf "$out" -- "$@" ;;
esac`,
      [dir, out, format, ...names],
      o,
    );
    stopWatching?.();
    progress?.setStage("finishing");
  } catch (error) {
    // Don't leave a partial or empty archive behind (not on EXISTS: the file
    // is then somebody else's).
    if (!(error instanceof HttpError && error.code === "EXISTS")) {
      await removeQuietly(t, out);
    }
    throw error;
  } finally {
    stopWatching?.();
  }
}

const EXISTS_CHECK = `if [ -e "$1" ] || [ -L "$1" ]; then exit ${EXIT_EXISTS}; fi`;

/** Best-effort `rm -f`; never throws and ignores cancellation. */
async function removeQuietly(t: ListTarget, path: string): Promise<void> {
  try {
    await run(t, `rm -f -- "$1"`, [path]);
  } catch {
    /* nothing more to do */
  }
}

/**
 * Sets the stage, an estimated total (zip: the uncompressed size from the
 * listing; plain tar: the archive size; compressed tars: unknown) and starts
 * measuring how much `dest` has grown. Returns the stop function.
 */
async function startExtractProgress(
  t: ListTarget,
  archive: string,
  dest: string,
  tool: string,
  progress: OpProgress,
  o: OpOptions,
): Promise<() => void> {
  progress.setStage("scanning");
  const lower = archive.toLowerCase();
  if (tool === "unzip") {
    const text = await probe(t, `unzip -l "$1"`, [archive], o.signal);
    progress.setTotal(
      text === undefined ? undefined : parseUnzipTotal(text),
      true,
    );
  } else if (lower.endsWith(".tar")) {
    const text = await probe(t, `wc -c < "$1"`, [archive], o.signal);
    progress.setTotal(
      text === undefined ? undefined : parseWcBytes(text),
      true,
    );
  } else {
    progress.setTotal(undefined);
  }
  const usage = async () =>
    parseDuKb(
      (await probe(
        t,
        `du -sk -- "$1" 2>/dev/null; exit 0`,
        [dest],
        o.signal,
      )) ?? "",
    );
  const baseline = (await usage()) ?? 0;
  progress.setStage("extracting");
  return watchProgress(progress, async () => {
    const now = await usage();
    return now === undefined ? undefined : Math.max(0, now - baseline);
  });
}

/**
 * The names an archive would create directly in the destination, one per line
 * (the first path part of every entry); a single compressed file yields its
 * own name without the compression extension.
 */
const EXTRACT_LIST_FN = `list() {
  case "$k" in
    ${ZIP_PATTERN})
      if command -v unzip >/dev/null 2>&1; then unzip -Z1 "$1"; else bsdtar -tf "$1"; fi ;;
    *.tar.gz|*.tgz) tar -tzf "$1" ;;
    *.tar.bz2|*.tbz2|*.tbz) tar -tjf "$1" ;;
    *.tar.xz|*.txz) tar -tJf "$1" ;;
    *.tar.zst|*.tzst) zstd -dc -- "$1" | tar -tf - ;;
    *.7z)
      if s=$(pick ${SEVENZ_TOOLS.join(" ")}); then "$s" l -slt -ba -- "$1" </dev/null | sed -n 's/^Path = //p'
      else bsdtar -tf "$1"; fi ;;
    *.rar)
      if s=$(pick ${RAR_TOOLS.join(" ")}); then
        if [ "$s" = unrar ]; then unrar lb -p- -- "$1" </dev/null
        else "$s" l -slt -ba -- "$1" </dev/null | sed -n 's/^Path = //p'; fi
      else bsdtar -tf "$1"; fi ;;
    *.gz|*.bz2|*.xz|*.zst) b=\${1##*/}; printf '%s\\n' "\${b%.*}" ;;
    *) tar -tf "$1" ;;
  esac
}`;

// $1 archive, $2 destination, $3 overwrite.
const EXTRACT_SCRIPT = `mkdir -p -- "$2" || exit 1
${PICK_FN}
${lowerName("$1")}
${EXTRACT_LIST_FN}
if [ "$3" != 1 ]; then
  c=$(list "$1" 2>/dev/null | while IFS= read -r n; do
    n=\${n#./}; n=\${n%%/*}
    if [ -n "$n" ] && { [ -e "$2/$n" ] || [ -L "$2/$n" ]; }; then echo "$n"; break; fi
  done)
  if [ -n "$c" ]; then echo "$c" >&2; exit ${EXIT_EXISTS}; fi
fi
case "$k" in
  ${ZIP_PATTERN})
    if command -v unzip >/dev/null 2>&1; then unzip -o -q "$1" -d "$2"
    else bsdtar -xf "$1" -C "$2"; fi ;;
  *.tar.gz|*.tgz) tar -xzf "$1" -C "$2" ;;
  *.tar.bz2|*.tbz2|*.tbz) tar -xjf "$1" -C "$2" ;;
  *.tar.xz|*.txz) tar -xJf "$1" -C "$2" ;;
  *.tar.zst|*.tzst) zstd -dc -- "$1" | tar -xf - -C "$2" ;;
  *.7z)
    if s=$(pick ${SEVENZ_TOOLS.join(" ")}); then "$s" x -y -o"$2" -- "$1" </dev/null >/dev/null
    else bsdtar -xf "$1" -C "$2"; fi ;;
  *.rar)
    if s=$(pick ${RAR_TOOLS.join(" ")}); then
      if [ "$s" = unrar ]; then unrar x -y -o+ -p- -idq -- "$1" "$2/" </dev/null
      else "$s" x -y -o"$2" -- "$1" </dev/null >/dev/null; fi
    else bsdtar -xf "$1" -C "$2"; fi ;;
  *.gz|*.bz2|*.xz|*.zst)
    b=\${1##*/}; o=\${b%.*}
    if [ -z "$o" ]; then echo "$b: cannot name the extracted file" >&2; exit 1; fi
    if [ -d "$2/$o" ] && [ ! -L "$2/$o" ]; then echo "$o" >&2; exit ${EXIT_EXISTS}; fi
    p=$(mktemp "$2/.extract.XXXXXX") || exit 1
    trap 'rm -f -- "$p"' EXIT
    case "$k" in
      *.gz) gzip -dc -- "$1" ;;
      *.bz2) bzip2 -dc -- "$1" ;;
      *.xz) xz -dc -- "$1" ;;
      *) zstd -dc -- "$1" ;;
    esac > "$p" || exit $?
    m=$(stat -c %a -- "$1" 2>/dev/null)
    if [ -n "$m" ]; then chmod "$m" -- "$p" 2>/dev/null; fi
    mv -f -- "$p" "$2/$o" ;;
  *) tar -xf "$1" -C "$2" ;;
esac`;

/**
 * Extracts an archive into `dest` (created when missing). Without `overwrite`
 * it fails with EXISTS when a top-level entry of the archive is already there.
 * (Archives are listed with `unzip -Z1` / `tar -t` / `7z l`; where the tool
 * can't list, the check is skipped.) Besides zip and tar this unpacks 7z, rar
 * and single compressed files (.gz, .bz2, .xz, .zst).
 */
export async function extract(
  t: ListTarget,
  archive: string,
  dest: string,
  overwrite = false,
  o: OpOptions = {},
): Promise<void> {
  const kind = archiveKind(archive);
  if (!kind) throw new HttpError(400, "Unsupported archive type");
  const missing = missingGroup(t.capabilities.tools, extractTools(kind));
  if (missing) {
    throw new HttpError(
      501,
      `${missing.label} is not installed in this container`,
      "NO_TOOL",
      { tool: missing.label },
    );
  }
  const tool =
    kind === "zip" && t.capabilities.tools.includes("unzip") ? "unzip" : "";
  const progress = o.progress;
  let stopWatching: (() => void) | undefined;
  try {
    if (progress) {
      stopWatching = await startExtractProgress(
        t,
        archive,
        dest,
        tool,
        progress,
        o,
      );
    }
    await run(t, EXTRACT_SCRIPT, [archive, dest, overwrite ? "1" : "0"], o);
    progress?.setStage("finishing");
  } finally {
    stopWatching?.();
  }
}

export async function sha256(
  t: ListTarget,
  path: string,
  o: OpOptions = {},
): Promise<string> {
  if (!t.capabilities.tools.includes("sha256sum")) {
    throw new HttpError(501, "sha256sum is not installed", "NO_TOOL");
  }
  const result = await run(t, `sha256sum -- "$1"`, [path], o);
  return result.stdout.toString().split(/\s+/)[0];
}

/** Metadata for one path (following a symlink given directly). */
export async function statPath(
  t: ListTarget,
  path: string,
  o: OpOptions = {},
): Promise<FileEntry> {
  const dir = posix.dirname(path);
  const base = posix.basename(path);
  if (
    t.capabilities.exec &&
    (t.capabilities.findPrintf || t.capabilities.statC)
  ) {
    if (t.capabilities.findPrintf) {
      const result = await run(t, STAT_FIND, [path], o);
      const entry = parseFindOutput(result.stdout)[0];
      if (!entry) throw new HttpError(404, "Not found", "NOT_FOUND");
      return { ...entry, name: base };
    }
    const result = await run(t, STAT_BUSYBOX, [path], o);
    const entry = parseStatOutput(result.stdout, dir)[0];
    if (!entry) throw new HttpError(404, "Not found", "NOT_FOUND");
    return { ...entry, name: base };
  }
  if (path === "/") {
    return {
      name: "/",
      type: "directory",
      size: 0,
      mtime: 0,
      mode: 0o755,
      owner: "root",
      group: "root",
    };
  }
  const listing = await listViaCp(t, dir, o.signal);
  const entry = listing.entries.find((e) => e.name === base);
  if (!entry) throw new HttpError(404, "Not found", "NOT_FOUND");
  return entry;
}

export { EXIT_CONFLICT, EXIT_EXISTS };

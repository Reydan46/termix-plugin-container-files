import { posix } from "node:path";
import { randomBytes } from "node:crypto";
import { runCommand, type ExecResult } from "./exec.js";
import { errorFromResult, requireExec } from "./fs-ops.js";
import type { ListTarget } from "./fs-list.js";
import { HttpError } from "./helpers.js";
import { execScriptCommand } from "./shell-quote.js";
import { listArchive } from "./archive.js";
import { archiveKind, isSingleFile } from "./archive-kinds.js";

/**
 * What to do with the names an extraction would overwrite. The client asks
 * `extract-plan` for the names the extraction creates, lists the destination
 * itself, shows the conflict window and sends the answer back as `skip` (top
 * level names to leave out) and `renames` (top level name -> new name). Every
 * other name replaces what is there (folders are merged), as before.
 */
export interface ExtractPolicy {
  skip: string[];
  renames: Record<string, string>;
  /**
   * Top level names the user chose to replace. An existing destination name
   * that is neither skipped, renamed nor listed here is never overwritten.
   */
  replace: string[];
}

export interface ExtractPlanItem {
  name: string;
  isDirectory: boolean;
}

/**
 * `truncated`: the archive listing was cut off, so `items` may miss names.
 * The client must then not rely on it and uses the safe default (nothing is
 * overwritten without an explicit question).
 */
export interface ExtractPlan {
  items: ExtractPlanItem[];
  truncated: boolean;
}

const MAX_NAMES = 1000;

function planName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value === "." ||
    value === ".." ||
    /[\0\n/]/.test(value)
  ) {
    throw new HttpError(400, "Invalid name in the extract choices");
  }
  return value;
}

/** The `skip` / `renames` of a request, or null when it carries neither. */
export function parseExtractPolicy(body: {
  skip?: unknown;
  renames?: unknown;
  replace?: unknown;
}): ExtractPolicy | null {
  const { skip, renames, replace } = body;
  if (skip === undefined && renames === undefined) return null;
  if (skip !== undefined && !Array.isArray(skip)) {
    throw new HttpError(400, "skip must be a list of names");
  }
  if (
    renames !== undefined &&
    (typeof renames !== "object" || renames === null || Array.isArray(renames))
  ) {
    throw new HttpError(400, "renames must map names to new names");
  }
  if (replace !== undefined && !Array.isArray(replace)) {
    throw new HttpError(400, "replace must be a list of names");
  }
  const skipList = ((skip as unknown[] | undefined) ?? []).map(planName);
  const replaceList = ((replace as unknown[] | undefined) ?? []).map(planName);
  const pairs = Object.entries((renames as Record<string, unknown>) ?? {});
  if (skipList.length + pairs.length + replaceList.length > MAX_NAMES) {
    throw new HttpError(400, "Too many extract choices");
  }
  const map: Record<string, string> = {};
  const targets = new Set<string>();
  for (const [from, to] of pairs) {
    const name = planName(from);
    const target = planName(to);
    // Two items cannot land on one name.
    if (targets.has(target)) {
      throw new HttpError(400, `Several items are renamed to "${target}"`);
    }
    targets.add(target);
    map[name] = target;
  }
  // A new name cannot be the name of another item that is being renamed.
  for (const target of targets) {
    if (Object.hasOwn(map, target)) {
      throw new HttpError(
        400,
        `"${target}" is both a rename target and a renamed item`,
      );
    }
  }
  if (skipList.length === 0 && pairs.length === 0) return null;
  return {
    skip: [...new Set(skipList)],
    renames: map,
    replace: [...new Set(replaceList)],
  };
}

/**
 * The entries a "extract all" (no `chosen`) or an "extract these" creates in
 * the destination: top level names, one per chosen entry's own name.
 */
export async function extractPlanItems(
  t: ListTarget,
  archive: string,
  chosen: string[] | null,
  signal?: AbortSignal,
): Promise<ExtractPlan> {
  const kind = archiveKind(archive);
  if (kind && isSingleFile(kind)) {
    // A .gz / .bz2 / .xz / .zst holds one file, named like the archive.
    const base = posix.basename(archive);
    return {
      items: [
        { name: base.slice(0, base.lastIndexOf(".")), isDirectory: false },
      ],
      truncated: false,
    };
  }
  let truncated = false;
  if (chosen === null) {
    const root = await listArchive(t, archive, "/", signal);
    return {
      items: root.entries.map((e) => ({
        name: e.name,
        isDirectory: e.type === "directory",
      })),
      truncated: root.truncated,
    };
  }
  const items = new Map<string, ExtractPlanItem>();
  const parents = new Map<string, Map<string, boolean>>();
  for (const path of chosen) {
    const dir = posix.dirname(path);
    const name = posix.basename(path);
    let siblings = parents.get(dir);
    if (!siblings) {
      const listing = await listArchive(t, archive, dir, signal);
      if (listing.truncated) truncated = true;
      siblings = new Map(
        listing.entries.map((e) => [e.name, e.type === "directory"]),
      );
      parents.set(dir, siblings);
    }
    if (!siblings.has(name)) {
      throw new HttpError(
        404,
        `Not found in the archive: ${path}`,
        "NOT_FOUND",
      );
    }
    items.set(name, { name, isDirectory: siblings.get(name) ?? false });
  }
  return { items: [...items.values()], truncated };
}

// $1 staging folder, $2 destination, $3 number of skipped names, then those
// names, then the number of names to replace and those names, then pairs
// "old new". The staging folder holds the extracted items under their final
// names; skipped ones are dropped, renamed ones move to their new name (which
// must be free), a name that exists in the destination is replaced (a folder
// merges) only when it is listed to replace. Everything is checked before the
// first move (17 / 18: a name is taken, 19: a rename target is also a staged
// name); a failure after that prints "cf-placed: name" for every item already
// placed and "cf-failed: name" for the one that failed (exit 20).
export const PLACE_SCRIPT = `st=$1; d=$2; ns=$3; shift 3
nl='
'
trap 'rm -rf -- "$st"' EXIT
i=0
while [ "$i" -lt "$ns" ]; do rm -rf -- "$st/$1"; shift; i=$((i+1)); done
nr=$1; shift
rp=$nl; i=0
while [ "$i" -lt "$nr" ]; do rp="$rp$1$nl"; shift; i=$((i+1)); done
rs=$nl
check() {
  while [ "$#" -ge 2 ]; do
    if [ -e "$d/$2" ] || [ -L "$d/$2" ]; then echo "$2" >&2; exit 17; fi
    if [ -e "$st/$2" ] || [ -L "$st/$2" ]; then echo "$2" >&2; exit 19; fi
    rs="$rs$1$nl"; shift 2
  done
}
check "$@"
for s in "$st"/* "$st"/.[!.]* "$st"/..?*; do
  if [ ! -e "$s" ] && [ ! -L "$s" ]; then continue; fi
  b=\${s##*/}
  case "$rs" in *"$nl$b$nl"*) continue;; esac
  if [ -e "$d/$b" ] || [ -L "$d/$b" ]; then
    case "$rp" in *"$nl$b$nl"*) ;; *) echo "$b" >&2; exit 18;; esac
  fi
done
fail() { echo "cf-failed: $1" >&2; exit 20; }
place() {
  while [ "$#" -ge 2 ]; do
    mv -- "$st/$1" "$d/$2" || fail "$2"
    echo "cf-placed: $2" >&2; shift 2
  done
}
place "$@"
for s in "$st"/* "$st"/.[!.]* "$st"/..?*; do
  if [ ! -e "$s" ] && [ ! -L "$s" ]; then continue; fi
  b=\${s##*/}
  if [ -d "$s" ] && [ ! -L "$s" ] && [ -d "$d/$b" ] && [ ! -L "$d/$b" ]; then
    cp -a "$s/." "$d/$b/" || fail "$b"
  else
    rm -rf -- "$d/$b"; mv -- "$s" "$d/$b" || fail "$b"
  fi
  echo "cf-placed: $b" >&2
done`;

const CLEAN_SCRIPT = `rm -rf -- "$1"`;
const TIMEOUT_MS = 10 * 60 * 1000;

/** Arguments of PLACE_SCRIPT (exported for the tests). */
export function placeArguments(
  stage: string,
  dest: string,
  policy: ExtractPolicy,
): string[] {
  return [
    stage,
    dest,
    String(policy.skip.length),
    ...policy.skip,
    String(policy.replace.length),
    ...policy.replace,
    ...Object.entries(policy.renames).flat(),
  ];
}

/** The error of a failed PLACE_SCRIPT run, naming what was already placed. */
export function placeError(result: ExecResult): HttpError {
  if (result.code === 18) {
    return new HttpError(409, "Already exists", "EXISTS");
  }
  if (result.code === 19) {
    const name = result.stderr.trim().split(/\r?\n/)[0];
    return new HttpError(
      400,
      `"${name}" is both a rename target and an extracted name`,
      "BAD_REQUEST",
    );
  }
  if (result.code === 20) {
    const lines = result.stderr.split(/\r?\n/);
    const placed = lines
      .filter((l) => l.startsWith("cf-placed: "))
      .map((l) => l.slice(11));
    const failed =
      lines.find((l) => l.startsWith("cf-failed: "))?.slice(11) ?? "";
    const reason = lines
      .filter((l) => l.trim() && !/^cf-(placed|failed): /.test(l))
      .join("\n");
    return new HttpError(
      500,
      `Extraction stopped at "${failed}"${reason ? ` (${reason})` : ""}; ` +
        (placed.length > 0
          ? `already placed: ${placed.join(", ")}`
          : "nothing was placed"),
      "EXTRACT_PARTIAL",
      { placed, failed, reason },
    );
  }
  return errorFromResult(result);
}

export function stageDirectory(dest: string): string {
  return posix.join(dest, `.cf-extract-${randomBytes(6).toString("hex")}`);
}

/**
 * Extracts into a staging folder inside `dest` (so the final move stays on one
 * filesystem), then places each item according to `policy`. `extractInto`
 * does the real extraction of the archive (or of the chosen entries) into the
 * folder it is given, with overwrite on. The staging folder is always removed.
 */
export async function extractWithPolicy(
  t: ListTarget,
  dest: string,
  policy: ExtractPolicy,
  extractInto: (stage: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  requireExec(t);
  const stage = stageDirectory(dest);
  const exec = (script: string, args: string[], abort?: AbortSignal) =>
    runCommand(
      t.client,
      execScriptCommand(t.runtime, t.containerId, script, args),
      { signal: abort, timeoutMs: TIMEOUT_MS },
    );
  try {
    await extractInto(stage);
    const result = await exec(
      PLACE_SCRIPT,
      placeArguments(stage, dest, policy),
      signal,
    );
    if (result.code !== 0) throw placeError(result);
  } finally {
    // Cancelled or failed: nothing of the half-done extraction stays behind.
    await exec(CLEAN_SCRIPT, [stage]).catch(() => undefined);
  }
}

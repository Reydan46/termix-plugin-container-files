import { archiveKindOf } from "./archiveKinds";
import { isVirtualPath } from "./archivePath";
import type { Translate } from "./capabilityMessages";
import type { AppendKind, Capabilities } from "./types";

// "Add to archive": which files accept an append, which items may be added,
// and how the backend's refusals are worded. Pure, so it is tested alone.

interface PathItem {
  name: string;
  path: string;
}

interface TargetItem extends PathItem {
  type: string;
}

/** Archive names the append operation accepts (not rar, not single .gz files). */
export function canAppendTo(name: string): boolean {
  return appendKind(name) !== null;
}

/**
 * Paths of an in-app drag that may be added to an archive open in a window of
 * `containerId`: only drags of that container's own files qualify.
 */
export function appendDragPaths(
  drag: { containerId: string | null; paths: string[] } | null,
  containerId: string,
): string[] | null {
  return drag && drag.containerId === containerId && drag.paths.length > 0
    ? drag.paths
    : null;
}

/**
 * The container tool an append to this archive needs: zip, tar, or for 7z the
 * installed 7-Zip build (`tools` is the probe's list; "7z" when none is).
 */
export function appendTool(
  archiveName: string,
  tools: readonly string[] = [],
): string {
  const kind = appendKind(archiveName);
  if (kind === "zip") return "zip";
  if (kind === "7z") {
    return ["7zz", "7z", "7za", "7zr"].find((t) => tools.includes(t)) ?? "7z";
  }
  return "tar";
}

/** Whether files may be dropped on `target` to be added to it. */
export function isAppendDropTarget(
  target: TargetItem,
  currentFolder: string,
): boolean {
  return (
    target.type !== "directory" &&
    canAppendTo(target.name) &&
    !isVirtualPath(currentFolder) &&
    !isVirtualPath(target.path)
  );
}

/** The dragged or picked items that can go into `archivePath`. */
export function appendSources<T extends PathItem>(
  items: T[],
  archivePath: string,
): T[] {
  return items.filter(
    (f) => f.path !== archivePath && !archivePath.startsWith(`${f.path}/`),
  );
}

/** Locale key for a refused append, or null for an error without its own text. */
export function appendErrorKey(
  code: string | undefined,
  reason: string | undefined,
): string | null {
  switch (code) {
    case "APPEND_UNSUPPORTED":
      return `containerFiles.appendUnsupported.${reason ?? "format"}`;
    case "ARCHIVE_READ_ONLY":
      return "containerFiles.appendReadOnly";
    case "INCLUDES_ARCHIVE":
      return "containerFiles.appendIncludesArchive";
    default:
      return null;
  }
}

/** The reasons the backend can give with APPEND_UNSUPPORTED. */
export const APPEND_REASONS = [
  "busybox-tar",
  "no-compressor",
  "symlink",
  "format",
  "rar",
  "single-file",
] as const;

/** The append kind of an archive name (matches the backend's archiveKind). */
export function appendKind(name: string): AppendKind | null {
  const kind = archiveKindOf(name);
  switch (kind) {
    case "zip":
    case "tar":
    case "tgz":
    case "tbz":
    case "txz":
    case "tzst":
    case "7z":
      return kind;
    default:
      return null;
  }
}

/** Locale key of the fixed reason a format cannot be added to or deleted from, else null. */
export function readOnlyFormatKey(
  name: string,
  group: "appendUnsupported" | "deleteUnsupported",
): string | null {
  const kind = archiveKindOf(name);
  if (kind === "rar") return `containerFiles.${group}.rar`;
  if (kind === "gz" || kind === "bz2" || kind === "xz" || kind === "zst") {
    return `containerFiles.${group}.single-file`;
  }
  return null;
}

type Verdict =
  { ok: true } | { ok: false; reason: string; tool?: string } | undefined;

/** Text for a refusal verdict of the probe (append or delete), or null when fine. */
export function verdictText(
  v: Verdict,
  t: Translate,
  area: string,
): string | null {
  if (!v || v.ok === true) return null;
  if (v.reason === "busybox-tar") return t(`containerFiles.${area}.busyboxTar`);
  if (v.reason === "gnu-tar") return t(`containerFiles.${area}.gnuTar`);
  return t(`containerFiles.${area}.noTool`, { tool: v.tool ?? "tar" });
}

type AppendCaps = Pick<Capabilities, "exec" | "appendSupport"> | null;

/**
 * Why files cannot be added to the archive `name` in this container, decided
 * up front from the probe; null when they can, or when the probe has no
 * verdict (an older server): then the request is tried and its error mapped.
 */
export function appendBlock(
  caps: AppendCaps,
  name: string,
  t: Translate,
): string | null {
  const fixed = readOnlyFormatKey(name, "appendUnsupported");
  if (fixed) return t(fixed);
  if (!caps?.exec || !caps.appendSupport) return null;
  const kind = appendKind(name);
  return kind
    ? verdictText(caps.appendSupport[kind], t, "appendBlocked")
    : null;
}

/** What to tell a drag hovering an archive: the drop is welcome, or refused with the reason. */
export type AppendDropHint =
  { kind: "allow"; text: string } | { kind: "blocked"; text: string };

/**
 * The hint for `dragged` hovering `target` (a file in `currentFolder`): null
 * for anything that is not an archive that accepts a drop or when nothing is
 * left to add; "blocked" with the concrete reason when the probe knows the
 * append cannot work (an older server has no verdict, so no blocked hint).
 */
export function appendDropHintFor(
  dragged: PathItem[],
  target: TargetItem,
  currentFolder: string,
  caps: AppendCaps,
  t: Translate,
): AppendDropHint | null {
  if (!isAppendDropTarget(target, currentFolder)) return null;
  if (appendSources(dragged, target.path).length === 0) return null;
  const reason = appendBlock(caps, target.name, t);
  return reason
    ? { kind: "blocked", text: reason }
    : {
        kind: "allow",
        text: t("containerFiles.appendDropHint", { name: target.name }),
      };
}

/** The reason when no archive type can be added to at all, else null. */
export function appendBlockAll(caps: AppendCaps, t: Translate): string | null {
  if (!caps?.exec || !caps.appendSupport) return null;
  const verdicts = Object.values(caps.appendSupport);
  if (verdicts.length === 0 || verdicts.some((v) => v.ok)) return null;
  return verdictText(verdicts[0], t, "appendBlocked");
}

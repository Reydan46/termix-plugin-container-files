import { appendKind, readOnlyFormatKey, verdictText } from "./appendHelpers";
import type { Translate } from "./capabilityMessages";
import type { Capabilities } from "./types";

// "Delete from archive": which archives accept it, why one does not, and how
// the backend's refusals are worded. Pure, so it is tested alone.

/** Archive names entries can be deleted from (not rar, not single .gz files). */
export function canDeleteFrom(name: string): boolean {
  return appendKind(name) !== null;
}

type DeleteCaps = Pick<Capabilities, "exec" | "deleteSupport"> | null;

/**
 * Why entries cannot be deleted from the archive `name` in this container,
 * decided up front from the probe; null when they can, or when the probe has
 * no verdict (an older server): then the request is tried and its error mapped.
 */
export function deleteBlock(
  caps: DeleteCaps,
  name: string,
  t: Translate,
): string | null {
  const fixed = readOnlyFormatKey(name, "deleteUnsupported");
  if (fixed) return t(fixed);
  if (!caps?.exec || !caps.deleteSupport) return null;
  const kind = appendKind(name);
  return kind
    ? verdictText(caps.deleteSupport[kind], t, "deleteBlocked")
    : null;
}

/** The reasons the backend can give with DELETE_UNSUPPORTED. */
export const DELETE_REASONS = [
  "gnu-tar",
  "no-compressor",
  "symlink",
  "format",
  "rar",
  "single-file",
] as const;

/** Locale key for a refused delete, or null for an error without its own text. */
export function deleteErrorKey(
  code: string | undefined,
  reason: string | undefined,
): string | null {
  switch (code) {
    case "DELETE_UNSUPPORTED":
      return `containerFiles.deleteUnsupported.${reason ?? "format"}`;
    case "ARCHIVE_READ_ONLY":
      return "containerFiles.deleteReadOnly";
    case "ARCHIVE_WOULD_BE_EMPTY":
      return "containerFiles.deleteWouldBeEmpty";
    case "UNSUPPORTED_NAME":
      return "containerFiles.deleteUnsupportedName";
    default:
      return null;
  }
}

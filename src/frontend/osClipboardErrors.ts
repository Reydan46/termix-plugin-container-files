// Why an Explorer clipboard step failed, as text for a toast. Pure: the request
// code lives in osClipboardApi, the toasts in osClipboardCopy / ContainerFileManager.

import type { TranslateFn } from "@termix-ssh/plugin-sdk/frontend";

/** A failed `/local/clipboard/*` request: the backend's reason and code. */
export class ClipboardRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ClipboardRequestError";
  }
}

export interface ClipboardFailure {
  /** Locale key of the sentence. */
  key: string;
  /** The concrete reason (PowerShell message, last console line...), if any. */
  detail: string;
}

const KEYS: Record<string, string> = {
  UNSUPPORTED: "containerFiles.osClipboardReasonUnsupported",
  NOT_DESKTOP: "containerFiles.osClipboardReasonNotDesktop",
  CLIP_SPAWN: "containerFiles.osClipboardReasonSpawn",
  CLIP_TIMEOUT: "containerFiles.osClipboardReasonTimeout",
  CLIP_EXIT: "containerFiles.osClipboardReasonExit",
  CLIP_SCRIPT: "containerFiles.osClipboardReasonScript",
  CLIP_TOO_LONG: "containerFiles.osClipboardReasonTooLong",
};

const UNKNOWN = "containerFiles.osClipboardReasonUnknown";
const NO_ANSWER = "containerFiles.osClipboardReasonNoAnswer";

interface Shaped {
  message?: unknown;
  code?: unknown;
  response?: { data?: { error?: unknown; code?: unknown } } | null;
}

/** The error text and code out of a thrown value (an Error, an axios error...). */
export function readFailure(error: unknown): {
  message: string;
  code: string | undefined;
  answered: boolean;
} {
  const e = (
    typeof error === "object" && error !== null
      ? error
      : { message: typeof error === "string" ? error : "" }
  ) as Shaped;
  const data = e.response?.data;
  const message =
    typeof data?.error === "string" && data.error
      ? data.error
      : typeof e.message === "string"
        ? e.message
        : "";
  const code =
    typeof data?.code === "string"
      ? data.code
      : typeof e.code === "string"
        ? e.code
        : undefined;
  // A response (even a 404) means the backend answered; none means it did not.
  const answered =
    !!data || error instanceof ClipboardRequestError || !("response" in e);
  return { message, code, answered };
}

/** The part of a backend reason after "<what failed>: ". */
function detailOf(message: string): string {
  const at = message.indexOf(": ");
  return (at >= 0 ? message.slice(at + 2) : "").trim();
}

/**
 * Maps a failure to a locale key plus the concrete reason. Codes the backend
 * sets name the cause (no PowerShell, timeout, script error...); anything else
 * keeps its own message so no failure is shown without a reason.
 */
export function describeClipboardError(error: unknown): ClipboardFailure {
  const { message, code, answered } = readFailure(error);
  if (!answered) return { key: NO_ANSWER, detail: message };
  const key = code ? KEYS[code] : undefined;
  if (key) {
    return {
      key,
      detail: code?.startsWith("CLIP_") ? detailOf(message) : message,
    };
  }
  return { key: UNKNOWN, detail: message };
}

/** Toast text: "<sentence>[: <reason>]". */
export function clipboardErrorText(error: unknown, t: TranslateFn): string {
  const { key, detail } = describeClipboardError(error);
  const sentence = t(key, { detail });
  return detail && !sentence.includes(detail)
    ? `${sentence}: ${detail}`
    : sentence;
}

import { createHash } from "node:crypto";
import type { PluginLogger } from "@termix-ssh/plugin-sdk/backend";

export function getErrorMessage(
  error: unknown,
  fallback = "Unknown error",
): string {
  return error instanceof Error ? error.message : fallback;
}

type Meta = Record<string, unknown>;

export interface Logger {
  info: (message: string, meta?: Meta) => void;
  warn: (message: string, meta?: Meta) => void;
  error: (message: string, errorOrMeta?: unknown, meta?: Meta) => void;
}

function withMeta(message: string, meta?: Meta): string {
  if (!meta || Object.keys(meta).length === 0) return message;
  try {
    return `${message} ${JSON.stringify(meta)}`;
  } catch {
    return message;
  }
}

export function createLogger(log: PluginLogger): Logger {
  return {
    info: (message, meta) => log.info(withMeta(message, meta)),
    warn: (message, meta) => log.warn(withMeta(message, meta)),
    error: (message, errorOrMeta, meta) => {
      if (errorOrMeta instanceof Error) {
        log.error(withMeta(message, meta), errorOrMeta);
        return;
      }
      log.error(
        withMeta(message, {
          ...((errorOrMeta as Meta | undefined) ?? {}),
          ...meta,
        }),
      );
    },
  };
}

export type LogLevel = "info" | "success" | "warning" | "error";

/** One line of the connection log shown while connecting. */
export interface ConnectionLogLine {
  type: LogLevel;
  stage: string;
  message: string;
}

export function connectionLog(
  type: LogLevel,
  stage: string,
  message: string,
): ConnectionLogLine {
  return { type, stage, message };
}

/** Container ids and names as accepted by docker/podman. */
export const CONTAINER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** A failure that maps to a specific HTTP status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    /** Structured diagnostics, sent to the client next to the message. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const PART_PREFIX = ".cf-part-";
const MAX_NAME_BYTES = 255;

/** Cuts `text` to at most `max` UTF-8 bytes without splitting a character. */
function cutBytes(text: string, max: number): string {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

/**
 * Hidden temporary name `.cf-part-<id8>-<name>` for a half-written upload. It
 * stays within the 255-byte file name limit: a long name is shortened, keeping
 * its extension, and a short hash of the full name keeps it unique.
 */
export function partName(transferId: string, name: string): string {
  const head = `${PART_PREFIX}${transferId.slice(0, 8)}-`;
  if (Buffer.byteLength(head + name) <= MAX_NAME_BYTES) return head + name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
  const stem = ext ? name.slice(0, dot) : name;
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
  const room = MAX_NAME_BYTES - Buffer.byteLength(head + ext) - hash.length - 1;
  return `${head}${cutBytes(stem, room)}~${hash}${ext}`;
}

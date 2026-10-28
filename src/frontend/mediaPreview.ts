// Decides whether a file can be previewed in the viewer or must be downloaded.
//
// Media and PDFs are downloaded into a Blob and handed to the viewer as an
// object URL (no base64 string, so V8's ~512 MiB string limit and the 1.33x
// base64 growth do not apply). What limits the preview is therefore memory:
//
//   download peak  ~ PEAK x file size   (received chunks + the assembled Blob)
//   budget         = min(deviceMemory x 25%, jsHeapSizeLimit x 50%)
//   max file size  = clamp(budget / PEAK, 64 MiB, 2 GiB)
//
// - navigator.deviceMemory is the device RAM in GiB (rounded, capped at 8);
//   a quarter of it is the most one tab may reasonably hold.
// - performance.memory.jsHeapSizeLimit (Chromium) is the real per-tab JS heap
//   cap; half of it leaves room for the app itself.
// - PEAK is 2 for images, audio and video, 3 for PDF (pdf.js copies the bytes).
// - Without either API (Firefox, Safari) the budget is a conservative 512 MiB.
// - The 2 GiB ceiling is the largest size browsers reliably handle in a Blob or
//   ArrayBuffer; the 64 MiB floor keeps ordinary files previewable on small
//   devices.
// Independently of size, a file the browser cannot decode (checked with
// HTMLMediaElement.canPlayType for audio/video) is offered for download at once.

import { resolveFilePreviewKind } from "./vendor/file-manager/file-preview-preload";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export type PreviewVerdict =
  | { preview: true; kind: string }
  | { preview: false; reason: "unsupported" | "tooLarge"; limit: number };

const MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
  m4a: "audio/mp4",
  flac: "audio/flac",
};

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** The memory-derived size limit for previewing a file of this kind. */
export function previewSizeLimit(
  kind: string,
  env: {
    deviceMemory?: number;
    jsHeapSizeLimit?: number;
  } = readEnvironment(),
): number {
  const peak = kind === "pdf" ? 3 : 2;
  const budgets: number[] = [];
  if (env.deviceMemory && env.deviceMemory > 0)
    budgets.push(env.deviceMemory * GiB * 0.25);
  if (env.jsHeapSizeLimit && env.jsHeapSizeLimit > 0)
    budgets.push(env.jsHeapSizeLimit * 0.5);
  const budget = budgets.length > 0 ? Math.min(...budgets) : 512 * MiB;
  return Math.round(Math.min(2 * GiB, Math.max(64 * MiB, budget / peak)));
}

function readEnvironment(): {
  deviceMemory?: number;
  jsHeapSizeLimit?: number;
} {
  try {
    const memory = (
      performance as unknown as {
        memory?: { jsHeapSizeLimit?: number };
      }
    ).memory;
    return {
      deviceMemory: (navigator as unknown as { deviceMemory?: number })
        .deviceMemory,
      jsHeapSizeLimit: memory?.jsHeapSizeLimit,
    };
  } catch {
    return {};
  }
}

function browserCanPlay(kind: "audio" | "video", mime: string): boolean {
  try {
    return document.createElement(kind).canPlayType(mime) !== "";
  } catch {
    return false;
  }
}

/** True for files the viewer shows as media or PDF (not as text). */
export function isPreviewableKind(kind: string): boolean {
  return (
    kind === "image" || kind === "video" || kind === "audio" || kind === "pdf"
  );
}

/**
 * Whether a file of this name and size can be previewed. `size` of 0 or
 * undefined means unknown; the download is then checked against the limit
 * while it runs.
 */
export function previewVerdict(
  name: string,
  size: number | undefined,
  env?: { deviceMemory?: number; jsHeapSizeLimit?: number },
  canPlay: (kind: "audio" | "video", mime: string) => boolean = browserCanPlay,
): PreviewVerdict | null {
  const kind = resolveFilePreviewKind(name);
  const ext = extensionOf(name);
  if (!isPreviewableKind(kind)) {
    // Media the viewer has no player for (tiff, ico, wma, ...) is not text.
    return MEDIA_ONLY_EXT.test(name)
      ? { preview: false, reason: "unsupported", limit: 0 }
      : null;
  }
  const limit = previewSizeLimit(kind, env);
  if (kind === "video" || kind === "audio") {
    if (!canPlay(kind, MIME[ext] ?? `${kind}/${ext}`))
      return { preview: false, reason: "unsupported", limit };
  }
  if (size && size > limit)
    return { preview: false, reason: "tooLarge", limit };
  return { preview: true, kind };
}

const MEDIA_ONLY_EXT = /\.(tiff?|ico|wma|m4v)$/i;

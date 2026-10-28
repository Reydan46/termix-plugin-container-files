import type { Capabilities } from "./types";

/**
 * Turns the probe result (machine-readable reason + tools) into specific,
 * translated messages. Pure: `t` is injected so the mapping is testable.
 */
export type Translate = (
  key: string,
  params?: Record<string, unknown>,
) => string;

export type Feature =
  | "create"
  | "rename"
  | "delete"
  | "paste"
  | "permissions"
  | "owner"
  | "compress"
  | "extract"
  | "upload"
  | "symlink"
  | "terminal";

/** Tools a feature needs when commands can run in the container. */
export const FEATURE_TOOLS: Record<Feature, string[]> = {
  create: ["mkdir", "touch"],
  rename: ["mv"],
  delete: ["rm"],
  paste: ["cp", "mv"],
  permissions: ["chmod"],
  owner: ["chown"],
  compress: ["tar"],
  extract: ["tar"],
  upload: [],
  symlink: ["ln"],
  terminal: [],
};

export const FEATURES = Object.keys(FEATURE_TOOLS) as Feature[];

const P = "containerFiles.limit";

/** Locale keys this module can ask for (checked against en/ru in tests). */
export const LIMIT_KEYS = [
  "stopped",
  "paused",
  "execDenied",
  "rootless",
  "noShell",
  "execFailed",
  "stillWorks",
  "feature",
  "toolMissing",
  "slowList",
  "archiveList",
  "missingTools",
  ...FEATURES.map((f) => `action.${f}`),
].map((k) => `${P}.${k}`);

const detailOf = (caps: Capabilities) =>
  caps.detail ? ` (${caps.detail})` : "";

/** Why commands cannot run in the container, or null when they can. */
export function execLimit(caps: Capabilities, t: Translate): string | null {
  if (caps.exec) return null;
  const detail = detailOf(caps);
  switch (caps.reason) {
    case "paused":
      return t(`${P}.paused`);
    case "no-shell":
      return t(`${P}.noShell`, { detail });
    case "exec-denied":
      return (
        t(`${P}.execDenied`, { detail }) +
        (caps.rootless ? ` ${t(`${P}.rootless`)}` : "")
      );
    case "exec-failed":
      return (
        t(`${P}.execFailed`, { detail }) +
        (caps.rootless ? ` ${t(`${P}.rootless`)}` : "")
      );
    case "stopped":
      return t(`${P}.stopped`);
    default:
      // Older backends send no reason: fall back on the running flag.
      return caps.running ? t(`${P}.noShell`, { detail }) : t(`${P}.stopped`);
  }
}

/** Tools of `feature` that this container lacks. */
export function missingTools(caps: Capabilities, feature: Feature): string[] {
  if (!caps.exec) return [];
  return FEATURE_TOOLS[feature].filter((tool) => !caps.tools.includes(tool));
}

/**
 * Why `feature` is unavailable, or null when it works. `tool` overrides the
 * tool list (e.g. "unzip" when extracting a zip).
 */
export function featureBlock(
  caps: Capabilities | null,
  feature: Feature,
  t: Translate,
  tool?: string,
): string | null {
  if (!caps) return null;
  const action = t(`${P}.action.${feature}`);
  if (!caps.exec) {
    return t(`${P}.feature`, { action, reason: execLimit(caps, t) });
  }
  const missing = tool
    ? caps.tools.includes(tool)
      ? []
      : [tool]
    : missingTools(caps, feature);
  if (missing.length === 0) return null;
  return t(`${P}.feature`, {
    action,
    reason: t(`${P}.toolMissing`, { tool: missing.join(", ") }),
  });
}

/** Notes about reduced functionality while commands still run. */
export function degradedNotes(caps: Capabilities, t: Translate): string[] {
  if (!caps.exec) return [];
  const notes: string[] = [];
  // The stat tier is not slower in practice, so it is only a detail
  // (listingDetail); only the archive tier is worth a warning.
  if (!caps.findPrintf && !caps.statC) notes.push(t(`${P}.archiveList`));
  const lacking = FEATURES.flatMap((f) => {
    const m = missingTools(caps, f);
    return m.length ? [`${t(`${P}.action.${f}`)} (${m.join(", ")})`] : [];
  });
  if (lacking.length) {
    notes.push(t(`${P}.missingTools`, { list: lacking.join(", ") }));
  }
  return notes;
}

/** Neutral detail about the listing mode (tooltip only, never a warning). */
export function listingDetail(
  caps: Capabilities | null,
  t: Translate,
): string | null {
  if (!caps?.exec || caps.findPrintf || !caps.statC) return null;
  return t(`${P}.slowList`);
}

export interface Banner {
  tone: "warn" | "info";
  text: string;
}

/** The status-bar message: what is limited, why, and what still works. */
export function capabilityBanner(
  caps: Capabilities | null,
  t: Translate,
): Banner | null {
  if (!caps) return null;
  if (!caps.exec) {
    return {
      tone: "warn",
      text: `${execLimit(caps, t)} ${t(`${P}.stillWorks`)}`,
    };
  }
  const notes = degradedNotes(caps, t);
  return notes.length ? { tone: "info", text: notes.join(" ") } : null;
}

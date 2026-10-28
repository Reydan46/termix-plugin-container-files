import { fileManagerApi } from "./vendor/file-manager/api/client";
import type { KnownFolderPaths } from "./localPathUtils";

const IDS = ["desktop", "documents", "downloads", "pictures"] as const;

/** Keeps the string paths of known ids; anything else is dropped. */
export function sanitizeKnownFolders(value: unknown): KnownFolderPaths {
  const out: KnownFolderPaths = {};
  if (!value || typeof value !== "object") return out;
  for (const id of IDS) {
    const path = (value as Record<string, unknown>)[id];
    if (typeof path === "string" && path && !path.includes("\0"))
      out[id] = path;
  }
  return out;
}

/** The real Desktop/Documents/Downloads/Pictures folders; {} when unknown. */
export async function getLocalKnownFolders(): Promise<KnownFolderPaths> {
  try {
    const response = await fileManagerApi().get<{
      success?: boolean;
      folders?: unknown;
    }>("/local/known-folders");
    return response.data?.success === true
      ? sanitizeKnownFolders(response.data.folders)
      : {};
  } catch {
    return {};
  }
}

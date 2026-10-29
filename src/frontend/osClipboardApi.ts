// Requests to this plugin's /local/clipboard/* routes (Termix Desktop only).

import { getApp } from "./app";
import { ClipboardRequestError } from "./osClipboardErrors";
import { getLocalHome } from "./vendor/file-manager/lib/local-files";

export interface ClipboardFileRef {
  path: string;
  isDirectory: boolean;
}

interface Reply {
  success?: boolean;
  error?: string;
  code?: string;
  dir?: string;
  files?: ClipboardFileRef[];
  own?: boolean;
  cleared?: boolean;
}

/** Calls a clipboard route; a refusal throws a ClipboardRequestError with the backend's code. */
export async function clipboardPost(
  route: string,
  body: Record<string, unknown>,
): Promise<Reply> {
  const res = await getApp().api.post(`/local/clipboard/${route}`, body);
  const data = res.data as Reply | undefined;
  if (data?.success !== true)
    throw new ClipboardRequestError(
      data?.error || `The clipboard route "${route}" failed`,
      data?.code,
    );
  return data;
}

/** Files and folders copied in Explorer, read through local PowerShell. */
export async function readExplorerClipboard(): Promise<{
  files: ClipboardFileRef[];
  own: boolean;
}> {
  const data = await clipboardPost("read", {});
  return { files: data.files ?? [], own: data.own === true };
}

let platform: Promise<string | null> | null = null;

/**
 * Platform of this computer (cached). A failed lookup is not cached and is
 * rethrown, so callers can say why instead of silently doing nothing.
 */
export function localPlatform(): Promise<string | null> {
  platform ??= getLocalHome()
    .then((h) => h.platform ?? null)
    .catch((error) => {
      platform = null;
      throw error;
    });
  return platform;
}

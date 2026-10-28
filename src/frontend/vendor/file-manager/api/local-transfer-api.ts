// Shim: desktop local disk <-> container transfers. Implemented in the
// transfer stage; until then the desktop pane reports it as unavailable.
interface Progress {
  transferred: number;
  total?: number;
}
type ProgressListener = (event: Progress) => void;

export function createLocalTransferId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function uploadLocalFileToSession(_options: {
  sessionId: string;
  remoteDir: string;
  localPath: string;
  fileName: string;
  hostId?: number;
  transferId?: string;
  onProgress?: ProgressListener;
}): Promise<void> {
  throw new Error("Local transfers are not available yet");
}

export async function downloadSessionFileToLocal(_options: {
  sessionId: string;
  remotePath: string;
  destPath: string;
  rootPath: string;
  expectedSize?: number;
  overwrite?: boolean;
  transferId?: string;
  onProgress?: ProgressListener;
}): Promise<void> {
  throw new Error("Local transfers are not available yet");
}

export async function cancelLocalTransfer(_transferId: string): Promise<void> {}

// An in-app drag of archive entries out of an ArchiveWindow. The DataTransfer
// carries the same data under ARCHIVE_ENTRIES_MIME, but browsers hide it during
// dragover, so the workspace also keeps it here.

export const ARCHIVE_ENTRIES_MIME =
  "application/x-container-files-archive-entries";

export interface ArchiveDrag {
  containerId: string;
  archive: string;
  /** Archive-inner paths such as "/sub/file.txt". */
  entries: string[];
}

let active: ArchiveDrag | null = null;

export function setArchiveDrag(drag: ArchiveDrag): void {
  active = drag;
}

export function getArchiveDrag(): ArchiveDrag | null {
  return active;
}

export function clearArchiveDrag(): void {
  active = null;
}

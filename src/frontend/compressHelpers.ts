export const COMPRESS_FORMATS = ["zip", "tar.gz", "tar"] as const;

/** The archive name suggested for the selection (no extension). */
export function defaultArchiveName(fileNames: string[]): string {
  if (fileNames.length === 1) return fileNames[0].replace(/\.[^/.]+$/, "");
  return "archive";
}

/** The trimmed name with the format's extension appended when missing. */
export function finalArchiveName(name: string, format: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  const ext = `.${format}`;
  return trimmed.endsWith(ext) ? trimmed : trimmed + ext;
}

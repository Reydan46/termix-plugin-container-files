/**
 * Name for a copy made next to its source: "a.txt" -> "a copy.txt",
 * "a.tar.gz" -> "a copy.tar.gz", ".env" -> ".env copy". Picks " copy 2", " copy 3"
 * ... when the name is taken.
 */
export function copyName(
  name: string,
  isTaken: (candidate: string) => boolean,
  isDirectory = false,
): string {
  const match = isDirectory
    ? null
    : /^(.+?)((?:\.tar)?\.[A-Za-z0-9_-]{1,10})$/.exec(name);
  const base = match ? match[1] : name;
  const ext = match ? match[2] : "";
  let candidate = `${base} copy${ext}`;
  for (let n = 2; isTaken(candidate); n++) {
    candidate = `${base} copy ${n}${ext}`;
  }
  return candidate;
}

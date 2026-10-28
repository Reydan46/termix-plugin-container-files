// Pure helpers for the permissions window: a file mode is kept as one number
// (0..0o7777) and converted to and from the octal text field and the
// checkbox grid. No React here so it can be tested on its own.

export type ModeClass = "owner" | "group" | "other";
export type ModeAccess = "read" | "write" | "execute";
export type ModeSpecial = "setuid" | "setgid" | "sticky";

const CLASS_SHIFT: Record<ModeClass, number> = {
  owner: 6,
  group: 3,
  other: 0,
};
const ACCESS_BIT: Record<ModeAccess, number> = {
  read: 4,
  write: 2,
  execute: 1,
};
export const SPECIAL_BIT: Record<ModeSpecial, number> = {
  setuid: 0o4000,
  setgid: 0o2000,
  sticky: 0o1000,
};

export const MODE_CLASSES: ModeClass[] = ["owner", "group", "other"];
export const MODE_ACCESS: ModeAccess[] = ["read", "write", "execute"];
export const MODE_SPECIAL: ModeSpecial[] = ["setuid", "setgid", "sticky"];

/** A complete octal mode: 3 or 4 digits, each 0-7. */
export const OCTAL_MODE_RE = /^[0-7]{3,4}$/;

/** What is left of typed text: only the digits 0-7, at most four of them. */
export function sanitizeOctalInput(raw: string): string {
  return raw.replace(/[^0-7]/g, "").slice(0, 4);
}

/** Parses "755", "0755", "4755"; null when it is not a complete octal mode. */
export function parseOctalMode(text: string): number | null {
  const value = text.trim();
  return OCTAL_MODE_RE.test(value) ? parseInt(value, 8) : null;
}

/** The 4-digit octal text sent to chmod, e.g. 0o755 -> "0755". */
export function formatMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/**
 * Reads a mode as the file listing delivers it: octal digits ("644", "4755")
 * or a symbolic string ("-rwxr-xr-x", "rwsr-xr-t"). Unreadable input is 0o644.
 */
export function parseMode(perms: string | undefined): number {
  const value = (perms ?? "").trim();
  const octal = parseOctalMode(value);
  if (octal !== null) return octal;
  const symbolic = value.length === 10 ? value.slice(1) : value;
  if (!/^[-rwxsStT]{9}$/.test(symbolic)) return 0o644;
  let mode = 0;
  MODE_CLASSES.forEach((cls, i) => {
    const [r, w, x] = symbolic.slice(i * 3, i * 3 + 3);
    if (r === "r") mode |= 4 << CLASS_SHIFT[cls];
    if (w === "w") mode |= 2 << CLASS_SHIFT[cls];
    if (x === "x" || x === "s" || x === "t") mode |= 1 << CLASS_SHIFT[cls];
    if (x === "s" || x === "S") mode |= i === 0 ? 0o4000 : 0o2000;
    if ((x === "t" || x === "T") && i === 2) mode |= 0o1000;
  });
  return mode;
}

export function hasAccess(
  mode: number,
  cls: ModeClass,
  access: ModeAccess,
): boolean {
  return (mode & (ACCESS_BIT[access] << CLASS_SHIFT[cls])) !== 0;
}

export function setAccess(
  mode: number,
  cls: ModeClass,
  access: ModeAccess,
  on: boolean,
): number {
  const bit = ACCESS_BIT[access] << CLASS_SHIFT[cls];
  return on ? mode | bit : mode & ~bit;
}

export function hasSpecial(mode: number, special: ModeSpecial): boolean {
  return (mode & SPECIAL_BIT[special]) !== 0;
}

export function setSpecial(
  mode: number,
  special: ModeSpecial,
  on: boolean,
): number {
  const bit = SPECIAL_BIT[special];
  return on ? mode | bit : mode & ~bit;
}

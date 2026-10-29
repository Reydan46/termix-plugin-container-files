import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { PluginDesktopLocal } from "@termix-ssh/plugin-sdk/backend";
import { getErrorMessage, HttpError } from "./helpers.js";
import { terminalLines } from "./known-folders.js";

/**
 * Windows only: the OS file clipboard through a short-lived local PowerShell.
 * The desktop SDK has no exec and no clipboard API (`PluginDesktopLocal` offers
 * a pty and files only), so a pty runs `powershell -EncodedCommand`.
 *
 * - Copy: the items are first downloaded into a temp directory of this plugin,
 *   then `Set-Clipboard -LiteralPath` lists its entries (what Explorer pastes).
 * - Paste: `Get-Clipboard -Format FileDropList` lists what Explorer copied.
 *
 * Paths never appear in script text: they travel base64-encoded (characters
 * A-Z a-z 0-9 + / = only) and every result comes back as base64 lines too, so
 * the console code page cannot mangle names. Failures keep their reason.
 */

export const TEMP_PREFIX = "termix-cf-clip-";
const MAX_LINE = 7000;
const MAX_OUTPUT = 512 * 1024;
const CHUNK = 1500;
/** Nested PowerShell start-up can take seconds on a busy machine. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Failure kinds a caller can tell apart (the codes of the HTTP errors). */
export type ClipboardErrorCode =
  "CLIP_SPAWN" | "CLIP_TIMEOUT" | "CLIP_EXIT" | "CLIP_SCRIPT" | "CLIP_TOO_LONG";

export function clipboardError(
  code: ClipboardErrorCode,
  detail?: string,
): HttpError {
  const text = (detail ?? "").trim().slice(0, 300);
  const base: Record<ClipboardErrorCode, string> = {
    CLIP_SPAWN: "Could not start a local PowerShell",
    CLIP_TIMEOUT: "PowerShell did not answer in time",
    CLIP_EXIT: "PowerShell closed before it finished",
    CLIP_SCRIPT: "PowerShell reported an error",
    CLIP_TOO_LONG: "The command for PowerShell is too long",
  };
  return new HttpError(500, text ? `${base[code]}: ${text}` : base[code], code);
}

const endMarker = (nonce: string) => `CFPSEND${nonce}`;
const errPrefix = (nonce: string) => `CFPSERR${nonce}:`;
const outPrefix = (nonce: string) => `CFPSOUT${nonce}:`;

/**
 * Wraps `body` (statements) so a run always ends with an END or an ERR marker.
 * The markers are assembled at run time: the echoed command line never holds
 * them as whole lines.
 */
export function wrapScript(body: string, nonce: string): string {
  const fail = `$m=[string]$_.Exception.Message;if($m.Length -gt 300){$m=$m.Substring(0,300)};Write-Output ('CFPS'+'ERR'+'${nonce}:'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($m)))`;
  return [
    `$ErrorActionPreference='Stop'`,
    `$ProgressPreference='SilentlyContinue'`,
    `try{${body};Write-Output ('CFPS'+'END'+'${nonce}')}catch{${fail}}`,
  ].join(";");
}

/** PowerShell statements that print `variable` as base64 chunks, one line each. */
function printOut(variable: string, nonce: string): string {
  return [
    `$b=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${variable}))`,
    `for($i=0;$i -lt $b.Length;$i+=${CHUNK}){Write-Output ('CFPS'+'OUT'+'${nonce}:'+$b.Substring($i,[Math]::Min(${CHUNK},$b.Length-$i)))}`,
  ].join(";");
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** Body of the Copy script: the entries of `dir` go on the file clipboard. */
export function setBody(dir: string): string {
  return [
    `$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(dir)}'))`,
    `$p=@(Get-ChildItem -LiteralPath $d -Force|ForEach-Object{$_.FullName})`,
    `if($p.Count -eq 0){throw 'Nothing to copy'}`,
    `Set-Clipboard -LiteralPath $p`,
  ].join(";");
}

/**
 * Body of the Copy script for real local paths (a Copy in the local pane):
 * the paths travel newline-joined as base64 (a Windows name cannot hold a
 * newline) and go on the file clipboard as they are, nothing is copied.
 */
export function setPathsBody(paths: string[]): string {
  return [
    `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(paths.join("\n"))}'))`,
    `$p=@($t -split [string][char]10|Where-Object{$_})`,
    `if($p.Count -eq 0){throw 'Nothing to copy'}`,
    `Set-Clipboard -LiteralPath $p`,
  ].join(";");
}

/** Body of the script that empties the clipboard. */
export function clearBody(): string {
  return `Set-Clipboard -Value $null`;
}

/** Windows paths compare without case, slash direction or a trailing slash. */
function samePathSet(a: readonly string[], b: readonly string[]): boolean {
  const norm = (p: string) =>
    p
      .replace(/[\\/]+/g, "/")
      .replace(/(.)\/$/, "$1")
      .toLowerCase();
  const left = new Set(a.map(norm));
  const right = new Set(b.map(norm));
  return (
    left.size > 0 &&
    left.size === right.size &&
    [...right].every((p) => left.has(p))
  );
}

/** Body of the Paste script: "D<path>" / "F<path>" lines, newline joined. */
export function readBody(nonce: string): string {
  return [
    // Windows PowerShell 5.1 may hand the whole list over as one object, so
    // the names are taken by member enumeration, not through a pipeline.
    `$c=@(Get-Clipboard -Format FileDropList)`,
    `$n=@($c.FullName|Where-Object{$_})`,
    `$l=@(foreach($p in $n){$(if(Test-Path -LiteralPath $p -PathType Container){'D'}else{'F'})+$p})`,
    `$s=$l -join [string][char]10`,
    printOut("$s", nonce),
  ].join(";");
}

/** `powershell -EncodedCommand` line; null when it would be too long. */
export function powershellLine(body: string, nonce: string): string | null {
  if (!/^[A-Za-z0-9]+$/.test(nonce)) return null;
  const encoded = Buffer.from(wrapScript(body, nonce), "utf16le").toString(
    "base64",
  );
  const line = `powershell -NoProfile -NonInteractive -STA -EncodedCommand ${encoded}`;
  return line.length > MAX_LINE ? null : line;
}

export type PowerShellResult =
  { status: "ok"; output: string } | { status: "error"; message: string };

/**
 * Reads the markers of a run. Null while it is unfinished; the echoed command
 * line holds no marker, so only the real output counts.
 */
export function parsePowerShellOutput(
  output: string,
  nonce: string,
): PowerShellResult | null {
  const lines = terminalLines(output);
  const out = outPrefix(nonce);
  const err = errPrefix(nonce);
  const errLine = lines.find((l) => l.startsWith(err));
  if (errLine !== undefined) {
    const raw = errLine.slice(err.length);
    return {
      status: "error",
      message: Buffer.from(raw, "base64").toString("utf8").trim(),
    };
  }
  if (!lines.includes(endMarker(nonce))) return null;
  const data = lines
    .filter((l) => l.startsWith(out))
    .map((l) => l.slice(out.length))
    .join("");
  return {
    status: "ok",
    output: Buffer.from(data, "base64").toString("utf8"),
  };
}

/** The last meaningful line of a terminal dump, for "closed too early". */
export function lastOutputLine(output: string): string {
  const lines = terminalLines(output).filter((l) => l !== "");
  return lines[lines.length - 1] ?? "";
}

export interface ClipboardFile {
  path: string;
  isDirectory: boolean;
}

/** Lines of the Paste script's output as entries. */
export function parseFileList(output: string): ClipboardFile[] {
  const out: ClipboardFile[] = [];
  for (const line of output.split("\n")) {
    const kind = line[0];
    const path = line.slice(1).replace(/\r$/, "");
    if ((kind === "D" || kind === "F") && path)
      out.push({ path, isDirectory: kind === "D" });
  }
  return out;
}

/** Name of an entry directly inside the temp directory: no separators. */
export function isPlainName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !/[\\/\0:*?"<>|]/.test(name)
  );
}

const newNonce = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/**
 * Runs a script in a throw-away local pty and returns what it printed. Every
 * failure is an HttpError whose code says what went wrong (spawn, timeout,
 * early exit, script error).
 */
export async function runPowerShell(
  local: PluginDesktopLocal,
  makeBody: (nonce: string) => string,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<string> {
  const nonce = newNonce();
  const line = powershellLine(makeBody(nonce), nonce);
  if (!line) throw clipboardError("CLIP_TOO_LONG");
  let pty: Awaited<ReturnType<PluginDesktopLocal["pty"]["spawn"]>>;
  try {
    pty = await local.pty.spawn({ cols: 8000, rows: 24 });
  } catch (error) {
    throw clipboardError("CLIP_SPAWN", getErrorMessage(error, ""));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const offs: Array<() => void> = [];
  try {
    const result = await new Promise<PowerShellResult>((resolveRun, reject) => {
      let buffer = "";
      timer = setTimeout(
        () => reject(clipboardError("CLIP_TIMEOUT", lastOutputLine(buffer))),
        timeoutMs,
      );
      offs.push(
        pty.onData((chunk) => {
          if (buffer.length < MAX_OUTPUT) buffer += chunk;
          const done = parsePowerShellOutput(buffer, nonce);
          if (done) resolveRun(done);
        }),
        pty.onExit(() => {
          const done = parsePowerShellOutput(buffer, nonce);
          if (done) resolveRun(done);
          else reject(clipboardError("CLIP_EXIT", lastOutputLine(buffer)));
        }),
      );
      try {
        pty.write(`${line}\r`);
      } catch (error) {
        reject(clipboardError("CLIP_SPAWN", getErrorMessage(error, "")));
      }
    });
    if (result.status === "error")
      throw clipboardError("CLIP_SCRIPT", result.message);
    return result.output;
  } finally {
    if (timer) clearTimeout(timer);
    for (const off of offs) {
      try {
        off();
      } catch {
        /* gone */
      }
    }
    try {
      pty.kill();
    } catch {
      /* gone */
    }
  }
}

/** Lists the entries of `dir` (the current temp copy) on the OS clipboard. */
export async function setFileClipboard(
  local: PluginDesktopLocal,
  dir: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  await runPowerShell(local, () => setBody(dir), opts);
}

/** Puts real local paths (no temp copy) on the OS clipboard. */
export async function setPathsClipboard(
  local: PluginDesktopLocal,
  paths: string[],
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  await runPowerShell(local, () => setPathsBody(paths), opts);
}

/**
 * Empties the OS clipboard when it lists exactly `paths` (a local Cut that was
 * pasted: those files are gone). Anything newer that Explorer or another app
 * put there stays. Answers whether it was cleared.
 */
export async function clearPathsClipboard(
  local: PluginDesktopLocal,
  paths: string[],
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  const { files } = await readFileClipboard(local, opts);
  if (
    !samePathSet(
      files.map((f) => f.path),
      paths,
    )
  )
    return false;
  await runPowerShell(local, () => clearBody(), opts);
  return true;
}

/**
 * The paths of a local Copy that may go on the OS clipboard: absolute, no
 * control characters, at most 500. Throws on anything else.
 */
export function checkLocalPaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0)
    throw new Error("No paths to copy");
  if (paths.length > 500) throw new Error("Too many paths");
  for (const p of paths) {
    if (
      typeof p !== "string" ||
      !p ||
      !isAbsolute(p) ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f]/.test(p)
    )
      throw new Error("Invalid path");
  }
  return paths as string[];
}

/**
 * The files and folders Explorer copied. `own` is true when every one of them
 * is inside this plugin's current temp copy (the clipboard is our own Copy).
 */
export async function readFileClipboard(
  local: PluginDesktopLocal,
  opts: { timeoutMs?: number } = {},
): Promise<{ files: ClipboardFile[]; own: boolean }> {
  const output = await runPowerShell(local, (nonce) => readBody(nonce), opts);
  const files = parseFileList(output);
  return {
    files,
    own: files.length > 0 && files.every((f) => insideTempDir(f.path)),
  };
}

/** The temp copy of the last Copy: one directory at a time. */
let current: string | null = null;
let exitHooked = false;

function ours(dir: string): boolean {
  return (
    basename(dir).startsWith(TEMP_PREFIX) &&
    dirname(dir) === dirname(join(tmpdir(), "x"))
  );
}

/** True when `path` is the current temp copy or inside it. */
export function insideTempDir(path: string): boolean {
  if (!current) return false;
  const root = resolve(current).toLowerCase();
  const p = resolve(path).toLowerCase();
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

export async function prepareTempDir(): Promise<string> {
  await removeTempDir();
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  current = dir;
  if (!exitHooked) {
    exitHooked = true;
    process.once("exit", () => {
      if (current && ours(current))
        try {
          rmSync(current, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
    });
  }
  return dir;
}

export async function removeTempDir(): Promise<void> {
  const dir = current;
  current = null;
  if (dir && ours(dir))
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Checks that `dir` is the current temp copy and that `names` are in it;
 * returns the directory whose entries go on the clipboard. Throws on anything
 * unknown or empty.
 */
export async function checkTempCopy(
  dir: string,
  names: unknown[],
): Promise<string> {
  if (!current || dir !== current) throw new Error("Unknown temp directory");
  for (const name of names) {
    if (!isPlainName(name)) throw new Error("Invalid name");
    await stat(join(current, name));
  }
  if ((await readdir(current)).length === 0) throw new Error("Nothing to copy");
  return current;
}

import type { PluginDesktopLocal } from "@termix-ssh/plugin-sdk/backend";

/**
 * Real locations of the user's well-known folders. The desktop SDK exposes only
 * the home folder, so on Windows a short-lived local PowerShell is asked
 * (folders moved with Properties > Location or redirected to OneDrive), on
 * Linux ~/.config/user-dirs.dirs is read, elsewhere <home>/<Name> is used.
 * The parsing is pure and lives here; the I/O wrapper is `resolveKnownFolders`.
 */

export type KnownFolderId = "desktop" | "documents" | "downloads" | "pictures";
export type KnownFolders = Partial<Record<KnownFolderId, string>>;

const IDS: KnownFolderId[] = ["desktop", "documents", "downloads", "pictures"];
const FOLDER_NAMES: Record<KnownFolderId, string> = {
  desktop: "Desktop",
  documents: "Documents",
  downloads: "Downloads",
  pictures: "Pictures",
};

// eslint-disable-next-line no-control-regex
const ANSI =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** Output of a terminal as plain lines: escape codes gone, CRLF/CR split. */
export function terminalLines(output: string): string[] {
  return output
    .replace(ANSI, "")
    .split(/\r\n|\r|\n/)
    .map((l) =>
      l.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim(),
    );
}

/** Absolute Windows path: drive letter or UNC. */
export function isAbsoluteWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(p);
}

export function beginMarker(nonce: string): string {
  return `KFBEGIN${nonce}`;
}
export function endMarker(nonce: string): string {
  return `KFEND${nonce}`;
}

/**
 * The PowerShell script. Markers are assembled at run time so that the echoed
 * command line never contains them as whole lines.
 */
export function powershellScript(nonce: string): string {
  const q = (s: string) => `'${s}'`;
  const get = (id: KnownFolderId, special: string) =>
    `Write-Output (${q(`${id}=`)}+[Environment]::GetFolderPath(${q(special)}))`;
  return [
    `$ErrorActionPreference='SilentlyContinue'`,
    `Write-Output ('KFBEGIN'+${q(nonce)})`,
    get("desktop", "Desktop"),
    get("documents", "MyDocuments"),
    get("pictures", "MyPictures"),
    `$k='{374DE290-123F-4565-9164-39C4925E467B}'`,
    `$v=(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' -Name $k).$k`,
    `if($v){Write-Output ('downloads='+[Environment]::ExpandEnvironmentVariables($v))}`,
    `Write-Output ('KFEND'+${q(nonce)})`,
  ].join(";");
}

/** `powershell ... -EncodedCommand` line for a shell that is PowerShell or cmd. */
export function powershellCommandLine(nonce: string): string {
  const encoded = Buffer.from(powershellScript(nonce), "utf16le").toString(
    "base64",
  );
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

/**
 * Reads the folders between the markers. Null when the markers are missing or
 * out of order (the run did not finish); otherwise the valid absolute paths.
 */
export function parseKnownFoldersOutput(
  output: string,
  nonce: string,
): KnownFolders | null {
  const lines = terminalLines(output);
  const begin = beginMarker(nonce);
  const end = endMarker(nonce);
  const startAt = lines.lastIndexOf(begin);
  if (startAt < 0) return null;
  const endAt = lines.indexOf(end, startAt + 1);
  if (endAt < 0) return null;
  const out: KnownFolders = {};
  for (const line of lines.slice(startAt + 1, endAt)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const id = line.slice(0, eq) as KnownFolderId;
    if (!IDS.includes(id)) continue;
    const value = line.slice(eq + 1).trim();
    if (isAbsoluteWindowsPath(value)) out[id] = value.replace(/[\\/]+$/, "");
  }
  return out;
}

const XDG_KEYS: Record<string, KnownFolderId> = {
  XDG_DESKTOP_DIR: "desktop",
  XDG_DOCUMENTS_DIR: "documents",
  XDG_DOWNLOAD_DIR: "downloads",
  XDG_PICTURES_DIR: "pictures",
};

/** `~/.config/user-dirs.dirs` content to absolute paths, `$HOME` expanded. */
export function parseUserDirs(content: string, home: string): KnownFolders {
  const base = home.replace(/\/+$/, "");
  const out: KnownFolders = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(XDG_[A-Z]+_DIR)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const id = XDG_KEYS[m[1]];
    if (!id) continue;
    let value = m[2].trim();
    const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(value);
    if (quoted) value = quoted[1].replace(/\\(.)/g, "$1");
    else value = value.replace(/\s+#.*$/, "");
    value = value.replace(/^\$\{HOME\}|^\$HOME/, base);
    if (!value.startsWith("/") || value.includes("\0") || value.includes("$"))
      continue;
    out[id] = value.length > 1 ? value.replace(/\/+$/, "") : value;
  }
  return out;
}

/** The plain guess under the home folder. */
export function homeGuess(home: string, sep: string): KnownFolders {
  const base = home.replace(/[\\/]+$/, "");
  const out: KnownFolders = {};
  for (const id of IDS) out[id] = `${base}${sep}${FOLDER_NAMES[id]}`;
  return out;
}

export interface ResolveDeps {
  timeoutMs?: number;
  nonce?: () => string;
}

const MAX_OUTPUT = 64 * 1024;

/** Runs the PowerShell query in a throw-away local pty; null on any failure. */
export async function queryWindowsFolders(
  local: PluginDesktopLocal,
  { timeoutMs = 5000, nonce = defaultNonce }: ResolveDeps = {},
): Promise<KnownFolders | null> {
  const id = nonce();
  let pty: Awaited<ReturnType<PluginDesktopLocal["pty"]["spawn"]>> | null =
    null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe: Array<() => void> = [];
  const kill = () => {
    for (const off of unsubscribe.splice(0)) {
      try {
        off();
      } catch {
        /* already gone */
      }
    }
    try {
      pty?.kill();
    } catch {
      /* already gone */
    }
  };
  try {
    const result = new Promise<KnownFolders | null>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, timeoutMs);
    });
    const run = (async (): Promise<KnownFolders | null> => {
      const spawned = await local.pty.spawn({ cols: 4000, rows: 24 });
      pty = spawned;
      // The deadline passed while spawning: do not leave the shell behind.
      if (timedOut) {
        try {
          spawned.kill();
        } catch {
          /* already gone */
        }
        return null;
      }
      return new Promise<KnownFolders | null>((resolve) => {
        let buffer = "";
        unsubscribe.push(
          spawned.onData((chunk) => {
            if (buffer.length < MAX_OUTPUT) buffer += chunk;
            const parsed = parseKnownFoldersOutput(buffer, id);
            if (parsed) resolve(parsed);
          }),
          spawned.onExit(() => resolve(parseKnownFoldersOutput(buffer, id))),
        );
        spawned.write(`${powershellCommandLine(id)}\r`);
      });
    })();
    run.catch(() => undefined);
    return await Promise.race([result, run]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    kill();
  }
}

function defaultNonce(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

async function readText(
  local: PluginDesktopLocal,
  path: string,
): Promise<string | null> {
  try {
    const { stream } = await local.fs.openRead(path);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buf.length;
      if (total > 64 * 1024) break;
      chunks.push(buf);
    }
    (stream as { destroy?: () => void }).destroy?.();
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Existing well-known folders of this machine; ids that could not be resolved
 * (or whose folder is gone) are left out so callers fall back to guesses.
 */
export async function loadKnownFolders(
  local: PluginDesktopLocal,
  deps: ResolveDeps = {},
): Promise<KnownFolders> {
  const info = await local.info();
  let found: KnownFolders | null = null;
  if (info.platform === "win32") {
    found = await queryWindowsFolders(local, deps);
  } else if (info.platform === "linux") {
    const config = `${info.home.replace(/\/+$/, "")}/.config`;
    const content = await readText(local, `${config}/user-dirs.dirs`);
    found = content === null ? null : parseUserDirs(content, info.home);
  } else {
    found = homeGuess(info.home, info.separator);
  }
  if (!found) return {};
  const entries = Object.entries(found) as Array<[KnownFolderId, string]>;
  if (entries.length === 0) return {};
  let existing: string[];
  try {
    existing = await local.fs.exists(entries.map(([, p]) => p));
  } catch {
    return {};
  }
  const key = (p: string) => {
    const k = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return info.platform === "win32" ? k.toLowerCase() : k;
  };
  const present = new Set(existing.map(key));
  const out: KnownFolders = {};
  for (const [id, p] of entries) {
    if (present.has(key(p))) out[id] = p;
  }
  return out;
}

/** A per-process cache: the first success is kept, failures are retried. */
export function createKnownFoldersCache(
  load: () => Promise<KnownFolders>,
): () => Promise<KnownFolders> {
  let cached: Promise<KnownFolders> | null = null;
  return () => {
    if (!cached) {
      const attempt = load().then(
        (value) => {
          if (Object.keys(value).length === 0 && cached === attempt)
            cached = null;
          return value;
        },
        () => {
          if (cached === attempt) cached = null;
          return {} as KnownFolders;
        },
      );
      cached = attempt;
    }
    return cached;
  };
}

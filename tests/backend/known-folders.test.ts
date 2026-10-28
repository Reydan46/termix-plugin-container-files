import { describe, expect, it } from "vitest";
import type { PluginDesktopLocal } from "@termix-ssh/plugin-sdk/backend";
import {
  createKnownFoldersCache,
  homeGuess,
  loadKnownFolders,
  parseKnownFoldersOutput,
  parseUserDirs,
  powershellCommandLine,
  powershellScript,
  queryWindowsFolders,
  terminalLines,
} from "../../src/backend/known-folders";
import { resolveShortcuts } from "../../src/frontend/localPathUtils";
import { sanitizeKnownFolders } from "../../src/frontend/localKnownFolders";

const N = "abc123";
const body = [
  "KFBEGIN" + N,
  "desktop=D:\\Data\\Desktop",
  "documents=C:\\Users\\me\\OneDrive\\Documents",
  "pictures=C:\\Users\\me\\Pictures",
  "downloads=E:\\Downloads",
  "KFEND" + N,
];

describe("terminalLines", () => {
  it("strips escape codes and splits CRLF and CR", () => {
    expect(
      terminalLines("\u001b[32mhi\u001b[0m\r\nthere\rx\u001b]0;title\u0007"),
    ).toEqual(["hi", "there", "x"]);
  });
});

describe("parseKnownFoldersOutput", () => {
  it("reads the block between the markers", () => {
    const out = parseKnownFoldersOutput(body.join("\r\n") + "\r\nPS> ", N);
    expect(out).toEqual({
      desktop: "D:\\Data\\Desktop",
      documents: "C:\\Users\\me\\OneDrive\\Documents",
      pictures: "C:\\Users\\me\\Pictures",
      downloads: "E:\\Downloads",
    });
  });

  it("ignores the echoed command line and ANSI noise", () => {
    const echo = `PS C:\\Users\\me> ${powershellCommandLine(N)}\r\n`;
    const ansi = body.map((l) => `\u001b[0m${l}\u001b[K`).join("\r\n");
    const out = parseKnownFoldersOutput(echo + ansi, N);
    expect(out?.downloads).toBe("E:\\Downloads");
    expect(out?.desktop).toBe("D:\\Data\\Desktop");
  });

  it("is null while a marker is missing", () => {
    expect(
      parseKnownFoldersOutput(body.slice(0, 3).join("\r\n"), N),
    ).toBeNull();
    expect(parseKnownFoldersOutput(body.slice(1).join("\r\n"), N)).toBeNull();
    expect(parseKnownFoldersOutput("", N)).toBeNull();
  });

  it("ignores another run's markers", () => {
    expect(parseKnownFoldersOutput(body.join("\n"), "other")).toBeNull();
  });

  it("drops relative, unknown and empty values", () => {
    const text = [
      "KFBEGIN" + N,
      "desktop=Desktop",
      "documents=",
      "music=C:\\Music",
      "garbage",
      "downloads=\\\\srv\\share\\dl\\",
      "KFEND" + N,
    ].join("\n");
    expect(parseKnownFoldersOutput(text, N)).toEqual({
      downloads: "\\\\srv\\share\\dl",
    });
  });

  it("uses the last begin marker", () => {
    const text = ["KFBEGIN" + N, "desktop=C:\\Old", ...body].join("\n");
    expect(parseKnownFoldersOutput(text, N)?.desktop).toBe("D:\\Data\\Desktop");
  });
});

describe("powershellScript", () => {
  it("never contains a marker as a whole token", () => {
    const script = powershellScript(N);
    expect(script).not.toContain("KFBEGIN" + N);
    expect(script).not.toContain("KFEND" + N);
    expect(script).toContain("374DE290-123F-4565-9164-39C4925E467B");
  });
});

describe("parseUserDirs", () => {
  it("expands $HOME and skips comments and bad lines", () => {
    const text = [
      "# comment",
      'XDG_DESKTOP_DIR="$HOME/Рабочий стол"',
      'XDG_DOWNLOAD_DIR="/mnt/data/dl/"',
      'XDG_DOCUMENTS_DIR="${HOME}/Docs"',
      'XDG_PICTURES_DIR="relative/pics"',
      'XDG_MUSIC_DIR="$HOME/Music"',
      'XDG_VIDEOS_DIR="$OTHER/v"',
    ].join("\n");
    expect(parseUserDirs(text, "/home/me/")).toEqual({
      desktop: "/home/me/Рабочий стол",
      downloads: "/mnt/data/dl",
      documents: "/home/me/Docs",
    });
  });
});

describe("homeGuess", () => {
  it("joins with the separator", () => {
    expect(homeGuess("/Users/me/", "/").downloads).toBe("/Users/me/Downloads");
  });
});

function fakeLocal(opts: {
  platform: string;
  home: string;
  separator: string;
  existing?: string[];
  files?: Record<string, string>;
  pty?: "ok" | "silent" | "exit" | "spawn-late";
}) {
  const state = { killed: 0, spawned: 0, written: "" };
  const handlers: {
    data: Array<(s: string) => void>;
    exit: Array<(c: number) => void>;
  } = {
    data: [],
    exit: [],
  };
  const local = {
    info: async () => ({
      home: opts.home,
      separator: opts.separator,
      platform: opts.platform,
    }),
    fs: {
      exists: async (paths: string[]) =>
        paths.filter((p) => (opts.existing ?? []).includes(p)),
      openRead: async (p: string) => {
        const text = opts.files?.[p];
        if (text === undefined) throw new Error("ENOENT");
        const { Readable } = await import("node:stream");
        return {
          stream: Readable.from([Buffer.from(text)]),
          size: text.length,
        };
      },
    },
    pty: {
      spawn: async () => {
        state.spawned++;
        if (opts.pty === "spawn-late")
          await new Promise((r) => setTimeout(r, 80));
        return {
          pid: 1,
          shell: "powershell",
          write: (data: string) => {
            state.written += data;
            const nonce = /EncodedCommand/.test(data)
              ? Buffer.from(data.split("-EncodedCommand ")[1].trim(), "base64")
                  .toString("utf16le")
                  .match(/KFBEGIN'\+'([^']+)'/)?.[1]
              : undefined;
            if (opts.pty === "ok" && nonce) {
              const out = [
                `PS> echoed\r\n`,
                `KFBEGIN${nonce}\r\n`,
                `desktop=D:\\Desk\r\n`,
                `downloads=E:\\Dl\r\n`,
                `KFEND${nonce}\r\n`,
              ];
              setTimeout(
                () => out.forEach((c) => handlers.data.forEach((h) => h(c))),
                0,
              );
            }
            if (opts.pty === "exit")
              setTimeout(() => handlers.exit.forEach((h) => h(1)), 0);
          },
          resize: () => undefined,
          kill: () => {
            state.killed++;
          },
          onData: (h: (s: string) => void) => {
            handlers.data.push(h);
            return () => undefined;
          },
          onExit: (h: (c: number) => void) => {
            handlers.exit.push(h);
            return () => undefined;
          },
        };
      },
    },
  };
  return { local: local as unknown as PluginDesktopLocal, state };
}

describe("queryWindowsFolders", () => {
  it("parses a finished run and kills the pty", async () => {
    const { local, state } = fakeLocal({
      platform: "win32",
      home: "C:\\Users\\me",
      separator: "\\",
      pty: "ok",
    });
    const out = await queryWindowsFolders(local, { nonce: () => "n1" });
    expect(out).toEqual({ desktop: "D:\\Desk", downloads: "E:\\Dl" });
    expect(state.killed).toBe(1);
  });

  it("times out when nothing is printed, still kills", async () => {
    const { local, state } = fakeLocal({
      platform: "win32",
      home: "C:\\Users\\me",
      separator: "\\",
      pty: "silent",
    });
    expect(await queryWindowsFolders(local, { timeoutMs: 30 })).toBeNull();
    expect(state.killed).toBe(1);
  });

  it("gives up when the shell exits early", async () => {
    const { local, state } = fakeLocal({
      platform: "win32",
      home: "C:\\Users\\me",
      separator: "\\",
      pty: "exit",
    });
    expect(await queryWindowsFolders(local, { timeoutMs: 500 })).toBeNull();
    expect(state.killed).toBe(1);
  });

  it("kills a pty that spawns after the deadline", async () => {
    const { local, state } = fakeLocal({
      platform: "win32",
      home: "C:\\Users\\me",
      separator: "\\",
      pty: "spawn-late",
    });
    expect(await queryWindowsFolders(local, { timeoutMs: 20 })).toBeNull();
    await new Promise((r) => setTimeout(r, 150));
    expect(state.killed).toBe(1);
  });
});

describe("loadKnownFolders", () => {
  it("keeps only folders that exist (Windows)", async () => {
    const { local } = fakeLocal({
      platform: "win32",
      home: "C:\\Users\\me",
      separator: "\\",
      pty: "ok",
      existing: ["D:\\Desk"],
    });
    expect(await loadKnownFolders(local, { nonce: () => "n2" })).toEqual({
      desktop: "D:\\Desk",
    });
  });

  it("reads user-dirs.dirs on Linux", async () => {
    const { local } = fakeLocal({
      platform: "linux",
      home: "/home/me",
      separator: "/",
      files: {
        "/home/me/.config/user-dirs.dirs": 'XDG_DOWNLOAD_DIR="$HOME/dl"\n',
      },
      existing: ["/home/me/dl"],
    });
    expect(await loadKnownFolders(local)).toEqual({ downloads: "/home/me/dl" });
  });

  it("is empty when user-dirs.dirs is missing on Linux", async () => {
    const { local } = fakeLocal({
      platform: "linux",
      home: "/home/me",
      separator: "/",
    });
    expect(await loadKnownFolders(local)).toEqual({});
  });

  it("guesses under home on macOS", async () => {
    const { local } = fakeLocal({
      platform: "darwin",
      home: "/Users/me",
      separator: "/",
      existing: ["/Users/me/Desktop", "/Users/me/Downloads"],
    });
    expect(await loadKnownFolders(local)).toEqual({
      desktop: "/Users/me/Desktop",
      downloads: "/Users/me/Downloads",
    });
  });
});

describe("createKnownFoldersCache", () => {
  it("caches a success and retries failures or empty answers", async () => {
    let calls = 0;
    const answers: Array<() => Promise<Record<string, string>>> = [
      async () => {
        throw new Error("x");
      },
      async () => ({}),
      async () => ({ desktop: "/d" }),
    ];
    const get = createKnownFoldersCache(() => answers[Math.min(calls++, 2)]());
    expect(await get()).toEqual({});
    expect(await get()).toEqual({});
    expect(await get()).toEqual({ desktop: "/d" });
    expect(await get()).toEqual({ desktop: "/d" });
    expect(calls).toBe(3);
  });
});

describe("resolveShortcuts with known folders", () => {
  it("prefers the real folder and still guesses the rest", async () => {
    const exists = async (paths: string[]) =>
      paths.filter((p) => p === "C:\\Users\\me\\Pictures");
    const out = await resolveShortcuts("C:\\Users\\me", "\\", exists, {
      desktop: "D:\\Desk",
    });
    expect(out).toEqual([
      { id: "home", path: "C:\\Users\\me" },
      { id: "desktop", path: "D:\\Desk" },
      { id: "pictures", path: "C:\\Users\\me\\Pictures" },
    ]);
  });
});

describe("sanitizeKnownFolders", () => {
  it("keeps string paths of known ids only", () => {
    expect(
      sanitizeKnownFolders({
        desktop: "/d",
        music: "/m",
        documents: 5,
        downloads: "",
      }),
    ).toEqual({ desktop: "/d" });
    expect(sanitizeKnownFolders(null)).toEqual({});
  });
});

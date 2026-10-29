import { beforeEach, describe, expect, it } from "vitest";
import {
  afterPaste,
  makeClipboard,
  pasteKind,
  type PaneClipboard,
} from "../../src/frontend/workspace/clipboard";
import {
  clipboardTimes,
  clipboardWinner,
  explorerPasteAction,
  invalidateInternalClipboard,
  markInternalClipboard,
  markOsClipboard,
  resetClipboardClock,
  samePaths,
} from "../../src/frontend/osClipboard";
import { layoutKey } from "../../src/frontend/layoutKey";
import { clearBody, setPathsBody } from "../../src/backend/os-clipboard";

const item = (path: string) => ({
  path,
  name: path.split(/[\\/]/).pop()!,
  isDirectory: false,
});

/**
 * The workspace in miniature: one clipboard, stamped by every Copy / Cut the
 * way ContainerWorkspace.putClip does, and the Ctrl+V decision a container
 * pane makes in Termix Desktop on Windows.
 */
function workspace() {
  let clip: PaneClipboard | null = null;
  return {
    copy(
      paneId: string,
      containerId: string | null,
      paths: string[],
      now: number,
      mode: "copy" | "cut" = "copy",
    ) {
      markInternalClipboard(now);
      clip = makeClipboard(paneId, containerId, paths.map(item), mode);
    },
    get clip() {
      return clip;
    },
    /** Ctrl+V in `paneId` showing `containerId`; `os` is what the OS clipboard holds. */
    paste(
      paneId: string,
      containerId: string,
      os: { paths: string[]; own: boolean },
    ): "nothing" | "internal" | "upload-from-explorer" {
      const hasInternal = !!clip;
      const internalWins =
        hasInternal &&
        clipboardWinner({ hasInternal, ...clipboardTimes() }) === "internal";
      if (internalWins)
        return pasteKind(clip, { paneId, containerId }) === "transfer"
          ? "internal"
          : "nothing";
      const local = clip && clip.containerId === null ? clip.items : null;
      const action = explorerPasteAction({
        fileCount: os.paths.length,
        own: os.own,
        hasInternal,
        matchesInternal:
          !!local &&
          samePaths(
            os.paths,
            local.map((i) => i.path),
          ),
      });
      if (action === "upload") return "upload-from-explorer";
      return action === "internal" ? "internal" : "nothing";
    },
  };
}

beforeEach(() => resetClipboardClock());

describe("the newest Copy wins", () => {
  it("container copy, then local copy, then paste in the container pastes the local items", () => {
    const ws = workspace();
    ws.copy("c1", "box", ["/srv/a.txt"], 10);
    // The user comes back from another window: the OS clipboard looks newer.
    markOsClipboard(20);
    ws.copy("local", null, ["C:\\Users\\me\\b.txt"], 30);
    expect(ws.clip?.containerId).toBeNull();
    expect(ws.clip?.items.map((i) => i.path)).toEqual(["C:\\Users\\me\\b.txt"]);
    // The OS clipboard still holds the container copy's temp files...
    expect(
      ws.paste("c1", "box", {
        paths: ["C:\\Temp\\termix-cf-clip-x\\a.txt"],
        own: true,
      }),
    ).toBe("internal");
    // ...or, after the local copy listed its real paths there, those.
    expect(
      ws.paste("c1", "box", { paths: ["c:/users/me/B.txt"], own: false }),
    ).toBe("internal");
  });

  it("a local copy that did not stamp the clipboard lost to a stale OS copy (the reported bug)", () => {
    // The old behaviour: no markInternalClipboard() for the local Copy.
    markInternalClipboard(10);
    markOsClipboard(20);
    expect(clipboardWinner({ hasInternal: true, ...clipboardTimes() })).toBe(
      "os",
    );
    // Stamped like every Copy now: the internal clipboard is newest.
    markInternalClipboard(30);
    expect(clipboardWinner({ hasInternal: true, ...clipboardTimes() })).toBe(
      "internal",
    );
  });

  it("an Explorer copy made after a Copy here wins; the next Copy wins again", () => {
    const ws = workspace();
    ws.copy("local", null, ["C:\\a.txt"], 10);
    markOsClipboard(20); // back from Explorer, where something else was copied
    expect(ws.paste("c1", "box", { paths: ["D:\\x.txt"], own: false })).toBe(
      "upload-from-explorer",
    );
    ws.copy("c1", "box", ["/srv/z"], 30);
    expect(ws.paste("c2", "box2", { paths: ["D:\\x.txt"], own: false })).toBe(
      "internal",
    );
  });

  it("a cut is spent after a paste, a copy stays", () => {
    const ws = workspace();
    ws.copy("local", null, ["C:\\a.txt"], 1, "cut");
    expect(afterPaste(ws.clip!, true)).toBeNull();
    expect(afterPaste(ws.clip!, false)).toBe(ws.clip);
  });
});

describe("samePaths", () => {
  it("ignores case, slash style, trailing slash and order", () => {
    expect(
      samePaths(["C:\\A\\b.txt", "C:\\A\\c"], ["c:/a/c/", "C:/A/B.TXT"]),
    ).toBe(true);
  });
  it("is false for different, longer or empty lists", () => {
    expect(samePaths(["a"], ["b"])).toBe(false);
    expect(samePaths(["a"], ["a", "b"])).toBe(false);
    expect(samePaths([], [])).toBe(false);
    expect(samePaths(["a", "a"], ["a", "b"])).toBe(false);
  });
});

describe("layoutKey", () => {
  it("names the physical key for Ctrl+letter on a non-Latin layout", () => {
    expect(layoutKey({ key: "с", code: "KeyC", ctrlKey: true })).toBe("c");
    expect(layoutKey({ key: "ч", code: "KeyX", metaKey: true })).toBe("x");
    expect(layoutKey({ key: "м", code: "KeyV", ctrlKey: true })).toBe("v");
    expect(layoutKey({ key: "ф", code: "KeyA", ctrlKey: true })).toBe("a");
  });
  it("keeps Latin letters (Dvorak, AZERTY) and other keys as typed", () => {
    expect(layoutKey({ key: "c", code: "KeyJ", ctrlKey: true })).toBe("c");
    expect(layoutKey({ key: "C", code: "KeyC", ctrlKey: true })).toBe("C");
    expect(layoutKey({ key: "Enter", code: "Enter", ctrlKey: true })).toBe(
      "Enter",
    );
    expect(layoutKey({ key: "ж", code: "Semicolon", ctrlKey: true })).toBe("ж");
  });
  it("leaves plain typing alone", () => {
    expect(layoutKey({ key: "с", code: "KeyC" })).toBe("с");
  });
});

describe("Copy in the local pane on the Windows clipboard", () => {
  it("sends the paths only as base64, newline joined", () => {
    const paths = ['C:\\it\'s "x" $(calc)\\файл 😀.txt', "D:\\two"];
    const body = setPathsBody(paths);
    const m = /FromBase64String\('([^']*)'\)/.exec(body)!;
    expect(Buffer.from(m[1], "base64").toString("utf8")).toBe(paths.join("\n"));
    expect(body).not.toContain("calc");
    expect(body).toContain("Set-Clipboard -LiteralPath $p");
    expect(body).not.toContain("ConvertFrom-Json");
  });
});

describe("emptying the clipboard after a pasted Cut", () => {
  it("clears with a fixed script that holds no path", () => {
    expect(clearBody()).toBe("Set-Clipboard -Value $null");
  });

  it("the internal clipboard stops winning once invalidated", () => {
    resetClipboardClock();
    markInternalClipboard(100);
    markOsClipboard(50);
    expect(clipboardWinner({ hasInternal: true, ...clipboardTimes() })).toBe(
      "internal",
    );
    invalidateInternalClipboard();
    expect(clipboardWinner({ hasInternal: true, ...clipboardTimes() })).toBe(
      "os",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  clipboardError,
  isPlainName,
  lastOutputLine,
  parseFileList,
  parsePowerShellOutput,
  powershellLine,
  readBody,
  setBody,
} from "../../src/backend/os-clipboard";
import {
  explorerPasteAction,
  isPasteKey,
  typesLatinV,
} from "../../src/frontend/osClipboard";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const decodeLine = (line: string) =>
  Buffer.from(line.split(" -EncodedCommand ")[1], "base64").toString("utf16le");

describe("PowerShell clipboard command", () => {
  it("carries the directory only as base64", () => {
    const dir = 'C:\\Temp\\it\'s "x" $(calc) `whoami` файл 😀';
    const body = setBody(dir);
    const m = /FromBase64String\('([^']*)'\)/.exec(body)!;
    expect(m[1]).toMatch(/^[A-Za-z0-9+/=]*$/);
    expect(Buffer.from(m[1], "base64").toString("utf8")).toBe(dir);
    expect(body).not.toContain(dir);
    expect(body).toContain("Set-Clipboard -LiteralPath $p");
  });
  it("collects the entries as an array (Windows PowerShell 5.1)", () => {
    const body = setBody("C:\\x");
    expect(body).toContain("$p=@(Get-ChildItem");
    expect(body).not.toContain("ConvertFrom-Json");
  });
  it("builds an STA encoded command line and rejects odd nonces", () => {
    const line = powershellLine(readBody("abc123"), "abc123")!;
    expect(line.startsWith("powershell -NoProfile -NonInteractive -STA")).toBe(
      true,
    );
    expect(decodeLine(line)).toContain("Get-Clipboard -Format FileDropList");
    expect(powershellLine("x", "a b")).toBeNull();
  });
  it("keeps the markers out of the echoed command line", () => {
    const line = powershellLine(readBody("n1"), "n1")!;
    expect(parsePowerShellOutput(`${line}\r\n`, "n1")).toBeNull();
    expect(parsePowerShellOutput(`${decodeLine(line)}\r\n`, "n1")).toBeNull();
  });
  it("refuses a line that is too long", () => {
    expect(powershellLine("x".repeat(9000), "n")).toBeNull();
  });
  it("reads ok, error and unfinished runs", () => {
    const text = b64("Dfolder\nFa.txt");
    expect(
      parsePowerShellOutput(`CFPSOUTn1:${text}\r\nCFPSENDn1\r\n`, "n1"),
    ).toEqual({ status: "ok", output: "Dfolder\nFa.txt" });
    expect(
      parsePowerShellOutput(`CFPSERRn1:${b64("Не найден путь")}\r\n`, "n1"),
    ).toEqual({ status: "error", message: "Не найден путь" });
    expect(parsePowerShellOutput("CFPSOUTn1:AAAA\r\n", "n1")).toBeNull();
    expect(parsePowerShellOutput("CFPSENDother\r\n", "n1")).toBeNull();
  });
  it("joins output chunks in order", () => {
    const text = `F${"é".repeat(2000)}`;
    const whole = b64(text);
    const run = parsePowerShellOutput(
      `CFPSOUTn:${whole.slice(0, 1500)}\r\nCFPSOUTn:${whole.slice(1500)}\r\nCFPSENDn\r\n`,
      "n",
    );
    expect(run).toEqual({ status: "ok", output: text });
  });
  it("parses the entry list with folder flags", () => {
    expect(parseFileList("DC:\\a\\dir\nFC:\\a\\f.txt\r\n\nX?\nF")).toEqual([
      { path: "C:\\a\\dir", isDirectory: true },
      { path: "C:\\a\\f.txt", isDirectory: false },
    ]);
    expect(parseFileList("")).toEqual([]);
  });
  it("names the last console line for an early exit", () => {
    expect(lastOutputLine("a\r\n\r\nboom\r\n\r\n")).toBe("boom");
    expect(lastOutputLine("")).toBe("");
  });
  it("makes errors with a code and the reason", () => {
    const e = clipboardError("CLIP_TIMEOUT", "  waiting  ");
    expect(e.status).toBe(500);
    expect(e.code).toBe("CLIP_TIMEOUT");
    expect(e.message).toBe("PowerShell did not answer in time: waiting");
    expect(clipboardError("CLIP_SPAWN").message).toBe(
      "Could not start a local PowerShell",
    );
  });
  it("accepts only plain names inside the temp directory", () => {
    expect(isPlainName("a b.txt")).toBe(true);
    for (const n of ["", ".", "..", "a/b", "a\\b", "C:x", "a\0b", 5])
      expect(isPlainName(n)).toBe(false);
  });
});

describe("Ctrl+V in Desktop", () => {
  it("recognises the physical V key on any layout", () => {
    expect(isPasteKey({ key: "v" })).toBe(true);
    expect(isPasteKey({ key: "V" })).toBe(true);
    expect(isPasteKey({ key: "м", code: "KeyV" })).toBe(true);
    expect(isPasteKey({ key: "c", code: "KeyC" })).toBe(false);
    expect(typesLatinV({ key: "м" })).toBe(false);
    expect(typesLatinV({ key: "v" })).toBe(true);
  });
  it("picks internal paste, upload or an empty notice", () => {
    const base = { fileCount: 2, own: false, hasInternal: false };
    expect(explorerPasteAction(base)).toBe("upload");
    expect(explorerPasteAction({ ...base, hasInternal: true })).toBe("upload");
    expect(explorerPasteAction({ ...base, own: true, hasInternal: true })).toBe(
      "internal",
    );
    expect(explorerPasteAction({ ...base, own: true })).toBe("empty");
    expect(explorerPasteAction({ ...base, fileCount: 0 })).toBe("empty");
    expect(
      explorerPasteAction({ ...base, fileCount: 0, hasInternal: true }),
    ).toBe("internal");
  });
});

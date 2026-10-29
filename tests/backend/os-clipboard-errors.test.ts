import { describe, expect, it } from "vitest";
import {
  ClipboardRequestError,
  clipboardErrorText,
  describeClipboardError,
} from "../../src/frontend/osClipboardErrors";

const axiosError = (error: string, code?: string) => ({
  message: "Request failed with status code 500",
  response: { data: { success: false, error, code } },
});

// A t() that returns the key and, when asked, the reason it was given.
const t = (key: string, vars?: Record<string, unknown>) =>
  vars?.detail ? `${key}[${String(vars.detail)}]` : key;

describe("describeClipboardError", () => {
  it("maps each backend code to its sentence", () => {
    const cases: [string, string][] = [
      ["UNSUPPORTED", "osClipboardReasonUnsupported"],
      ["NOT_DESKTOP", "osClipboardReasonNotDesktop"],
      ["CLIP_SPAWN", "osClipboardReasonSpawn"],
      ["CLIP_TIMEOUT", "osClipboardReasonTimeout"],
      ["CLIP_EXIT", "osClipboardReasonExit"],
      ["CLIP_SCRIPT", "osClipboardReasonScript"],
      ["CLIP_TOO_LONG", "osClipboardReasonTooLong"],
    ];
    for (const [code, key] of cases)
      expect(describeClipboardError(axiosError("x", code)).key).toBe(
        `containerFiles.${key}`,
      );
  });
  it("keeps the concrete reason after the colon", () => {
    expect(
      describeClipboardError(
        axiosError("PowerShell reported an error: Нет доступа", "CLIP_SCRIPT"),
      ),
    ).toEqual({
      key: "containerFiles.osClipboardReasonScript",
      detail: "Нет доступа",
    });
    expect(
      describeClipboardError(
        axiosError("Could not start a local PowerShell", "CLIP_SPAWN"),
      ).detail,
    ).toBe("");
  });
  it("reads the code of a ClipboardRequestError", () => {
    const e = new ClipboardRequestError("PowerShell closed: boom", "CLIP_EXIT");
    expect(describeClipboardError(e)).toEqual({
      key: "containerFiles.osClipboardReasonExit",
      detail: "boom",
    });
  });
  it("keeps the message of an unknown failure", () => {
    expect(describeClipboardError(new Error("disk full"))).toEqual({
      key: "containerFiles.osClipboardReasonUnknown",
      detail: "disk full",
    });
    expect(describeClipboardError(axiosError("Windows only", "WHAT"))).toEqual({
      key: "containerFiles.osClipboardReasonUnknown",
      detail: "Windows only",
    });
  });
  it("tells a missing backend answer apart", () => {
    const offline = Object.assign(new Error("Network Error"), {
      response: undefined,
      code: "ERR_NETWORK",
    });
    expect(describeClipboardError(offline)).toEqual({
      key: "containerFiles.osClipboardReasonNoAnswer",
      detail: "Network Error",
    });
  });
  it("never throws on odd values", () => {
    for (const v of [null, undefined, "boom", 5, {}])
      expect(describeClipboardError(v).key).toMatch(/^containerFiles\./);
  });
});

describe("clipboardErrorText", () => {
  it("appends the reason when the sentence does not hold it", () => {
    const e = axiosError(
      "PowerShell did not answer in time: waiting",
      "CLIP_TIMEOUT",
    );
    expect(clipboardErrorText(e, t as never)).toBe(
      "containerFiles.osClipboardReasonTimeout[waiting]",
    );
    const plain = (key: string) => key;
    expect(clipboardErrorText(e, plain as never)).toBe(
      "containerFiles.osClipboardReasonTimeout: waiting",
    );
  });
  it("uses the message as the reason for other codes", () => {
    expect(
      clipboardErrorText(
        axiosError("Windows only", "UNSUPPORTED"),
        ((k: string) => k) as never,
      ),
    ).toBe("containerFiles.osClipboardReasonUnsupported: Windows only");
  });
});

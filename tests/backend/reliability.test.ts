import { describe, expect, it } from "vitest";
import { openChannelAbortable } from "../../src/backend/exec";
import { partName } from "../../src/backend/helpers";
import {
  ContainerApiError,
  isTooLargeDownload,
} from "../../src/frontend/containerFsApi";
import { FakeStream } from "./fake-ssh";

describe("openChannelAbortable", () => {
  it("destroys a channel that opens after the cancel", async () => {
    const stream = new FakeStream();
    const client = {
      exec: (_c: string, cb: (e: undefined, s: FakeStream) => void) =>
        setTimeout(() => cb(undefined, stream), 5),
    };
    const controller = new AbortController();
    const opening = openChannelAbortable(
      client as never,
      "cmd",
      controller.signal,
    );
    controller.abort();
    await expect(opening).rejects.toMatchObject({ status: 499 });
    expect(stream.destroyed).toBe(true);
  });

  it("returns the channel when not cancelled", async () => {
    const stream = new FakeStream();
    const client = {
      exec: (_c: string, cb: (e: undefined, s: FakeStream) => void) =>
        cb(undefined, stream),
    };
    await expect(openChannelAbortable(client as never, "cmd")).resolves.toBe(
      stream,
    );
    expect(stream.destroyed).toBe(false);
  });
});

describe("partName", () => {
  it("keeps short names readable", () => {
    expect(partName("abcdefghij", "a.txt")).toBe(".cf-part-abcdefgh-a.txt");
  });

  it("stays within 255 bytes, keeps the extension and stays unique", () => {
    const a = partName("abcdefgh", "ж".repeat(200) + ".tar.gz");
    const b = partName("abcdefgh", "ж".repeat(201) + ".tar.gz");
    expect(Buffer.byteLength(a)).toBeLessThanOrEqual(255);
    expect(Buffer.byteLength(b)).toBeLessThanOrEqual(255);
    expect(a.endsWith(".gz")).toBe(true);
    expect(a).not.toBe(b);
    const long = partName("abcdefgh", "x".repeat(255));
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(255);
  });
});

describe("isTooLargeDownload", () => {
  it("recognises the blob fallback refusal", () => {
    expect(
      isTooLargeDownload(new ContainerApiError("x", 413, "TOO_LARGE")),
    ).toBe(true);
    expect(isTooLargeDownload(new Error("x"))).toBe(false);
  });
});

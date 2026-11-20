import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { packSingleFile } from "../../src/backend/tar";

describe("packSingleFile", () => {
  const uncaught: Error[] = [];
  const onUncaught = (error: Error) => uncaught.push(error);
  afterEach(() => {
    process.off("uncaughtException", onUncaught);
    uncaught.length = 0;
  });

  it("ends the pack with an error, not a crash, when the body stops short", async () => {
    process.on("uncaughtException", onUncaught);
    const body = new PassThrough();
    const pack = packSingleFile("a.bin", 10, body);
    const failed = new Promise<Error>((resolve) => pack.once("error", resolve));
    pack.resume();
    body.end("abc"); // an upload cut off by a cancel
    await expect(failed).resolves.toBeInstanceOf(Error);
    await new Promise((r) => setTimeout(r, 50));
    expect(uncaught).toEqual([]);
  });
});

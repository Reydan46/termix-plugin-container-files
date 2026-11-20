import { describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../src/frontend/app", () => ({
  getApp: () => ({ fetch: fetchMock, t: (k: string) => k }),
}));

describe("uploadFile pieces", () => {
  it("reports every piece under an id of its own", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ bytes: 1 }),
    }));
    const { uploadFile, UPLOAD_CHUNK } =
      await import("../../src/frontend/containerFsApi");
    const seen: Array<[string, number]> = [];
    const file = new Blob([new Uint8Array(UPLOAD_CHUNK + 10)]);
    await uploadFile(
      "s|abc",
      "/d",
      file,
      { name: "a.bin" },
      {
        transferId: "up-aaaa",
        onPiece: (id, offset) => seen.push([id, offset]),
      },
    );
    expect(seen).toEqual([
      ["up-aaaa-0", 0],
      ["up-aaaa-1", UPLOAD_CHUNK],
    ]);
    const ids = fetchMock.mock.calls.map((c) =>
      new URL(String(c[0]), "http://x").searchParams.get("transferId"),
    );
    expect(ids).toEqual(["up-aaaa-0", "up-aaaa-1"]);
  });

  it("keeps the given id for a file that fits one request", async () => {
    fetchMock.mockClear();
    const { uploadFile } = await import("../../src/frontend/containerFsApi");
    const seen: string[] = [];
    await uploadFile(
      "s|abc",
      "/d",
      new Blob(["x"]),
      { name: "a" },
      { transferId: "up-bbbb", onPiece: (id) => seen.push(id) },
    );
    expect(seen).toEqual(["up-bbbb"]);
  });
});

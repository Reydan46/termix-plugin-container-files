import { describe, expect, it, vi } from "vitest";
import {
  SERVER_OLDER_CODE,
  isMissingRoute,
  listFiles,
  toApiError,
} from "../../src/frontend/containerFsApi";

const fetchMock = vi.fn();
vi.mock("../../src/frontend/app", () => ({
  getApp: () => ({ api: {}, fetch: fetchMock, t: (k: string) => k }),
}));

describe("old server plugin", () => {
  it("tells a missing route from the plugin's own 404", () => {
    expect(isMissingRoute(404, undefined)).toBe(true);
    expect(isMissingRoute(404, "NOT_FOUND")).toBe(false);
    expect(isMissingRoute(500, undefined)).toBe(false);
  });

  it("maps an axios 404 without a code to the update message", () => {
    const error = toApiError({ response: { status: 404, data: {} } }, "x");
    expect(error.code).toBe(SERVER_OLDER_CODE);
    expect(error.message).toBe("containerFiles.serverOlder");
    expect(
      toApiError(
        {
          response: { status: 404, data: { code: "NOT_FOUND", error: "gone" } },
        },
        "x",
      ).message,
    ).toBe("gone");
  });

  it("maps a fetch 404 for both connection origins", async () => {
    for (const sid of ["cf-1-a", "cfr-1-a"]) {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => {
          throw new Error("not json");
        },
      });
      await expect(listFiles(`${sid}|abc`, "/")).rejects.toMatchObject({
        code: SERVER_OLDER_CODE,
        status: 404,
      });
    }
  });
});

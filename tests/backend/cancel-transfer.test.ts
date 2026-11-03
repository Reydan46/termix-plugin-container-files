import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("../../src/frontend/app", () => ({
  getApp: () => ({
    api: { get: vi.fn(), post },
    t: (k: string, v?: { message?: string }) => `${k}:${v?.message ?? ""}`,
  }),
}));

describe("cancelTransfer", () => {
  beforeEach(() => {
    post.mockReset();
    toastError.mockReset();
  });

  it("shows a toast when the cancel request fails", async () => {
    post.mockRejectedValue(new Error("host unreachable"));
    const { cancelTransfer } =
      await import("../../src/frontend/containerFsApi");
    await expect(cancelTransfer("t1", "local")).resolves.toBeUndefined();
    expect(toastError).toHaveBeenCalledWith(
      "workspace.cancelFailed:host unreachable",
    );
  });

  it("stays quiet when the cancel succeeds", async () => {
    post.mockResolvedValue({ data: {} });
    const { cancelTransfer } =
      await import("../../src/frontend/containerFsApi");
    await cancelTransfer("t1", "local");
    expect(toastError).not.toHaveBeenCalled();
  });
});

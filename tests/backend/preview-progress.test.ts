import { describe, expect, it, vi } from "vitest";
import {
  describePreviewProgress,
  formatTransferBytes,
  throttleProgress,
} from "../../src/frontend/vendor/file-manager/api/preview-progress";

const MiB = 1024 * 1024;

describe("preview progress", () => {
  it("formats sizes", () => {
    expect(formatTransferBytes(0)).toBe("0 B");
    expect(formatTransferBytes(512)).toBe("512 B");
    expect(formatTransferBytes(5 * MiB)).toBe("5.00 MB");
    expect(formatTransferBytes(150 * MiB)).toBe("150.0 MB");
  });

  it("gives a percentage when the total is known", () => {
    expect(
      describePreviewProgress({ loaded: 25 * MiB, total: 100 * MiB }),
    ).toEqual({
      percent: 25,
      loaded: "25.0 MB",
      total: "100.0 MB",
    });
    expect(describePreviewProgress({ loaded: 200, total: 100 }).percent).toBe(
      100,
    );
  });

  it("is indeterminate when the total is unknown", () => {
    expect(describePreviewProgress({ loaded: 3 * MiB })).toEqual({
      loaded: "3.00 MB",
    });
    expect(
      describePreviewProgress({ loaded: 1, total: 0 }).percent,
    ).toBeUndefined();
  });

  it("throttles calls", () => {
    let t = 0;
    const fn = vi.fn();
    const call = throttleProgress(fn, 100, () => t);
    call(1);
    t = 50;
    call(2);
    t = 100;
    call(3);
    expect(fn.mock.calls).toEqual([[1], [3]]);
  });
});

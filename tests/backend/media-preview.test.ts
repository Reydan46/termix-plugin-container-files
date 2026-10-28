import { describe, expect, it, vi } from "vitest";

// The real module pulls in the host UI SDK; only its kind table is needed.
vi.mock("../../src/frontend/vendor/file-manager/file-preview-preload", () => {
  const kinds: Record<string, string[]> = {
    image: ["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp"],
    video: ["mp4", "avi", "mkv", "mov", "wmv", "flv", "webm"],
    audio: ["mp3", "wav", "flac", "ogg", "aac", "m4a"],
    pdf: ["pdf"],
    code: ["txt"],
  };
  return {
    resolveFilePreviewKind: (name: string) => {
      const ext = name.toLowerCase().split(".").pop() ?? "";
      return (
        Object.keys(kinds).find((k) => kinds[k].includes(ext)) ?? "unknown"
      );
    },
  };
});

import {
  previewSizeLimit,
  previewVerdict,
} from "../../src/frontend/mediaPreview";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const yes = () => true;
const no = () => false;

describe("media preview feasibility", () => {
  it("uses 512 MiB budget without memory APIs", () => {
    expect(previewSizeLimit("image", {})).toBe(256 * MiB);
    expect(previewSizeLimit("pdf", {})).toBe(Math.round((512 * MiB) / 3));
  });

  it("takes the smaller of device memory and heap budgets", () => {
    // 8 GiB device -> 2 GiB budget; heap 1 GiB -> 512 MiB budget
    expect(
      previewSizeLimit("video", { deviceMemory: 8, jsHeapSizeLimit: GiB }),
    ).toBe(256 * MiB);
    expect(previewSizeLimit("video", { deviceMemory: 8 })).toBe(GiB);
  });

  it("clamps between 64 MiB and 2 GiB", () => {
    expect(previewSizeLimit("video", { deviceMemory: 0.25 })).toBe(64 * MiB);
    expect(previewSizeLimit("video", { jsHeapSizeLimit: 100 * GiB })).toBe(
      2 * GiB,
    );
  });

  it("previews supported media under the limit", () => {
    expect(previewVerdict("a.png", MiB, {}, yes)).toEqual({
      preview: true,
      kind: "image",
    });
  });

  it("offers download when too large", () => {
    const v = previewVerdict("a.png", 300 * MiB, {}, yes);
    expect(v).toMatchObject({ preview: false, reason: "tooLarge" });
  });

  it("offers download when the browser cannot decode audio or video", () => {
    expect(previewVerdict("a.mkv", MiB, {}, no)).toMatchObject({
      preview: false,
      reason: "unsupported",
    });
  });

  it("treats unsupported media formats as downloads and text as no verdict", () => {
    expect(previewVerdict("a.tiff", MiB, {}, yes)).toMatchObject({
      preview: false,
      reason: "unsupported",
    });
    expect(previewVerdict("a.txt", MiB, {}, yes)).toBeNull();
  });

  it("allows unknown size", () => {
    expect(previewVerdict("a.mp4", undefined, {}, yes)).toMatchObject({
      preview: true,
    });
  });
});

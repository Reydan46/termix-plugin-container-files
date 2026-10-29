import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APPEND_REASONS,
  appendBlock,
  appendTool,
  canAppendTo,
  readOnlyFormatKey,
} from "../../src/frontend/appendHelpers";
import {
  archiveKindOf,
  archiveToolFor,
  isSingleFileKind,
} from "../../src/frontend/archiveKinds";
import {
  DELETE_REASONS,
  canDeleteFrom,
  deleteBlock,
  deleteErrorKey,
} from "../../src/frontend/deleteHelpers";

const t = (k: string, p?: Record<string, unknown>) =>
  p?.tool ? `${k}:${p.tool}` : k;
const ok = { ok: true } as const;

describe("archive tools by format", () => {
  it("picks the installed 7-Zip build, else names 7z", () => {
    expect(archiveToolFor("a.7z", ["7za"])).toBe("7za");
    expect(archiveToolFor("a.7z", ["7zz", "7z"])).toBe("7zz");
    expect(archiveToolFor("a.7z", [])).toBe("7z");
  });

  it("opens rar with unrar or 7-Zip, names unrar when neither exists", () => {
    expect(archiveToolFor("a.rar", ["unrar"])).toBe("unrar");
    expect(archiveToolFor("a.rar", ["7z"])).toBe("7z");
    expect(archiveToolFor("a.rar", ["7za"])).toBe("unrar");
    expect(archiveToolFor("a.rar", [])).toBe("unrar");
  });

  it("needs tar and zstd for tar.zst, and names the missing one", () => {
    expect(archiveToolFor("a.tar.zst", ["tar", "zstd"])).toBe("tar");
    expect(archiveToolFor("a.tzst", ["tar"])).toBe("zstd");
    expect(archiveToolFor("a.tzst", ["zstd"])).toBe("tar");
  });

  it("allows bsdtar only when unpacking", () => {
    expect(archiveToolFor("a.7z", ["bsdtar"], true)).toBe("bsdtar");
    expect(archiveToolFor("a.7z", ["bsdtar"], false)).toBe("7z");
    expect(archiveToolFor("a.zip", ["bsdtar"], true)).toBe("bsdtar");
    expect(archiveToolFor("a.zip", ["bsdtar"], false)).toBe("unzip");
  });

  it("uses the matching compressor for single files", () => {
    expect(archiveToolFor("a.gz", [])).toBe("gzip");
    expect(archiveToolFor("a.bz2", [])).toBe("bzip2");
    expect(archiveToolFor("a.xz", ["xz"])).toBe("xz");
    expect(archiveToolFor("a.zst", [])).toBe("zstd");
  });

  it("answers tar for a name that is no archive", () => {
    expect(archiveToolFor("a.txt", ["tar"])).toBe("tar");
  });

  it("knows which kinds are single compressed files", () => {
    for (const n of ["a.gz", "a.bz2", "a.xz", "a.zst"]) {
      const kind = archiveKindOf(n);
      expect(kind && isSingleFileKind(kind), n).toBe(true);
    }
    for (const n of ["a.tar.gz", "a.zip", "a.7z", "a.rar", "a.tzst"]) {
      const kind = archiveKindOf(n);
      expect(kind && isSingleFileKind(kind), n).toBe(false);
    }
  });

  it("detects the zip aliases", () => {
    for (const n of ["a.jar", "a.war", "a.apk", "a.whl", "a.epub"]) {
      expect(archiveKindOf(n), n).toBe("zip");
    }
  });
});

describe("delete helpers", () => {
  const caps = (over: Record<string, unknown> = {}, exec = true) => ({
    exec,
    deleteSupport: {
      zip: ok,
      tar: ok,
      tgz: ok,
      tbz: ok,
      txz: ok,
      tzst: ok,
      "7z": ok,
      ...over,
    },
  });
  const noGnu = { ok: false, reason: "gnu-tar" } as const;

  it("accepts the formats that can be rewritten", () => {
    for (const n of ["a.zip", "a.tar.gz", "a.tzst", "a.7z", "a.jar"]) {
      expect(canDeleteFrom(n), n).toBe(true);
      expect(canDeleteFrom(n)).toBe(canAppendTo(n));
    }
    for (const n of ["a.rar", "a.gz", "a.zst", "a.txt"]) {
      expect(canDeleteFrom(n), n).toBe(false);
    }
  });

  it("gives rar and single files a fixed reason even without a probe", () => {
    expect(deleteBlock(null, "a.rar", t)).toBe(
      "containerFiles.deleteUnsupported.rar",
    );
    expect(deleteBlock({ exec: true }, "a.xz", t)).toBe(
      "containerFiles.deleteUnsupported.single-file",
    );
    expect(deleteBlock(caps(), "a.bz2", t)).toBe(
      "containerFiles.deleteUnsupported.single-file",
    );
  });

  it("explains a tar that is not GNU for tar kinds only", () => {
    const c = caps({ tar: noGnu, tgz: noGnu, tzst: noGnu });
    expect(deleteBlock(c, "a.tar", t)).toBe(
      "containerFiles.deleteBlocked.gnuTar",
    );
    expect(deleteBlock(c, "a.tar.gz", t)).toBe(
      "containerFiles.deleteBlocked.gnuTar",
    );
    expect(deleteBlock(c, "a.zip", t)).toBeNull();
    expect(deleteBlock(c, "a.7z", t)).toBeNull();
  });

  it("names the missing tool", () => {
    const c = caps({ "7z": { ok: false, reason: "no-tool", tool: "7z" } });
    expect(deleteBlock(c, "a.7z", t)).toBe(
      "containerFiles.deleteBlocked.noTool:7z",
    );
    expect(deleteBlock(c, "a.zip", t)).toBeNull();
  });

  it("has no verdict without a probe, without exec or for a non-archive", () => {
    expect(deleteBlock(null, "a.zip", t)).toBeNull();
    expect(deleteBlock({ exec: true }, "a.zip", t)).toBeNull();
    expect(deleteBlock(caps({ zip: noGnu }, false), "a.zip", t)).toBeNull();
    expect(deleteBlock(caps(), "a.txt", t)).toBeNull();
  });

  it("maps refusals to locale keys", () => {
    expect(deleteErrorKey("DELETE_UNSUPPORTED", "gnu-tar")).toBe(
      "containerFiles.deleteUnsupported.gnu-tar",
    );
    expect(deleteErrorKey("DELETE_UNSUPPORTED", undefined)).toBe(
      "containerFiles.deleteUnsupported.format",
    );
    expect(deleteErrorKey("ARCHIVE_READ_ONLY", undefined)).toBe(
      "containerFiles.deleteReadOnly",
    );
    expect(deleteErrorKey("ARCHIVE_WOULD_BE_EMPTY", undefined)).toBe(
      "containerFiles.deleteWouldBeEmpty",
    );
    expect(deleteErrorKey("UNSUPPORTED_NAME", undefined)).toBe(
      "containerFiles.deleteUnsupportedName",
    );
    expect(deleteErrorKey("NOT_FOUND", undefined)).toBeNull();
    expect(deleteErrorKey(undefined, undefined)).toBeNull();
    expect(DELETE_REASONS).toHaveLength(6);
  });
});

describe("append for 7z and rar", () => {
  const tools = ["tar", "zip", "7za"];

  it("names the 7-Zip build to check", () => {
    expect(appendTool("a.7z", tools)).toBe("7za");
    expect(appendTool("a.7z", ["7zz", "7za"])).toBe("7zz");
    expect(appendTool("a.7z", [])).toBe("7z");
    expect(appendTool("a.zip", tools)).toBe("zip");
    expect(appendTool("a.tzst", tools)).toBe("tar");
  });

  it("refuses rar and single files with a fixed reason", () => {
    expect(appendBlock(null, "a.rar", t)).toBe(
      "containerFiles.appendUnsupported.rar",
    );
    expect(appendBlock({ exec: true }, "a.gz", t)).toBe(
      "containerFiles.appendUnsupported.single-file",
    );
    expect(readOnlyFormatKey("a.zip", "appendUnsupported")).toBeNull();
    expect(readOnlyFormatKey("a.rar", "deleteUnsupported")).toBe(
      "containerFiles.deleteUnsupported.rar",
    );
  });

  it("uses the probe verdict for 7z", () => {
    const c = {
      exec: true,
      appendSupport: {
        zip: ok,
        tar: ok,
        tgz: ok,
        tbz: ok,
        txz: ok,
        tzst: ok,
        "7z": { ok: false, reason: "no-tool", tool: "7z" } as const,
      },
    };
    expect(appendBlock(c, "a.7z", t)).toBe(
      "containerFiles.appendBlocked.noTool:7z",
    );
  });
});

describe("archive format locale keys", () => {
  const en = JSON.parse(readFileSync("locales-src/en.json", "utf8"));
  const ru = JSON.parse(readFileSync("locales-src/ru.json", "utf8"));
  const at = (tree: unknown, key: string) =>
    key
      .split(".")
      .reduce<unknown>(
        (o, k) => (o as Record<string, unknown> | undefined)?.[k],
        tree,
      );

  it("has every key in en and ru", () => {
    const keys = [
      "archiveDelete",
      "archiveDeleteHint",
      "archiveDeleteConfirmTitle",
      "archiveDeleteConfirmDesc",
      "archiveDeleteConfirm",
      "deletingFromName",
      "archiveDeleteDone",
      "archiveDeleteFailed",
      "deleteReadOnly",
      "deleteWouldBeEmpty",
      "deleteUnsupportedName",
      "deleteBlocked.gnuTar",
      "deleteBlocked.noTool",
      "limit.action.archiveDelete",
      "opStage.rewriting",
      ...DELETE_REASONS.map((r) => `deleteUnsupported.${r}`),
      ...APPEND_REASONS.map((r) => `appendUnsupported.${r}`),
    ].map((k) => `containerFiles.${k}`);
    for (const key of keys) {
      expect(typeof at(en, key), `en ${key}`).toBe("string");
      expect(typeof at(ru, key), `ru ${key}`).toBe("string");
    }
  });

  it("keeps the placeholders in both languages", () => {
    for (const key of [
      "containerFiles.deleteBlocked.noTool",
      "containerFiles.deleteUnsupported.no-compressor",
      "containerFiles.appendUnsupported.no-compressor",
    ]) {
      expect(at(en, key) as string, `en ${key}`).toContain("{{tool}}");
      expect(at(ru, key) as string, `ru ${key}`).toContain("{{tool}}");
    }
    for (const lang of [en, ru]) {
      const desc = at(
        lang,
        "containerFiles.archiveDeleteConfirmDesc",
      ) as string;
      expect(desc).toContain("{{items}}");
      expect(desc).toContain("{{name}}");
    }
  });

  it("is built into locales/", () => {
    for (const lang of ["en", "ru"]) {
      const built = JSON.parse(readFileSync(`locales/${lang}.json`, "utf8"));
      expect(typeof at(built, "containerFiles.archiveDelete")).toBe("string");
      expect(typeof at(built, "containerFiles.deleteUnsupported.rar")).toBe(
        "string",
      );
    }
  });
});

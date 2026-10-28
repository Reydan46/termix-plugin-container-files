import { describe, expect, it, vi } from "vitest";
import {
  THIS_PC,
  breadcrumbParts,
  canonicalLocalPath,
  createDriveProbe,
  driveCandidates,
  driveLetterOf,
  isRootPath,
  localExpansionChain,
  mergeRoots,
  normalizeTypedPath,
  parentOf,
  parseLocalPath,
  rememberRoot,
  resolveShortcuts,
  shortcutCandidates,
  upTarget,
} from "../../src/frontend/localPathUtils";

describe("parseLocalPath", () => {
  it("splits a Windows drive path", () => {
    expect(parseLocalPath("C:\\Users\\me")).toEqual({
      kind: "drive",
      root: "C:\\",
      parts: ["Users", "me"],
      sep: "\\",
    });
  });

  it("accepts forward slashes and a bare drive", () => {
    expect(parseLocalPath("d:/a/b").parts).toEqual(["a", "b"]);
    expect(parseLocalPath("D:").root).toBe("D:\\");
    expect(parseLocalPath("D:").parts).toEqual([]);
  });

  it("splits UNC shares", () => {
    const p = parseLocalPath("\\\\srv\\share\\dir\\f");
    expect(p.kind).toBe("unc");
    expect(p.root).toBe("\\\\srv\\share\\");
    expect(p.parts).toEqual(["dir", "f"]);
  });

  it("splits POSIX paths", () => {
    expect(parseLocalPath("/home/me/x")).toEqual({
      kind: "posix",
      root: "/",
      parts: ["home", "me", "x"],
      sep: "/",
    });
    expect(parseLocalPath("/").parts).toEqual([]);
  });
});

describe("breadcrumbParts", () => {
  it("lists a Windows path root first", () => {
    expect(breadcrumbParts("C:\\Users\\me")).toEqual([
      { label: "C:", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
      { label: "me", path: "C:\\Users\\me" },
    ]);
  });

  it("lists a POSIX path", () => {
    expect(breadcrumbParts("/home/me")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "me", path: "/home/me" },
    ]);
  });

  it("lists a UNC path with the share as the root", () => {
    expect(breadcrumbParts("\\\\srv\\share\\a")).toEqual([
      { label: "\\\\srv\\share", path: "\\\\srv\\share\\" },
      { label: "a", path: "\\\\srv\\share\\a" },
    ]);
  });

  it("has no crumbs for This PC or an empty path", () => {
    expect(breadcrumbParts(THIS_PC)).toEqual([]);
    expect(breadcrumbParts("")).toEqual([]);
  });

  it("gives a drive root a single crumb", () => {
    expect(breadcrumbParts("E:\\")).toEqual([{ label: "E:", path: "E:\\" }]);
  });
});

describe("navigation targets", () => {
  it("finds parents", () => {
    expect(parentOf("C:\\a\\b")).toBe("C:\\a");
    expect(parentOf("C:\\a")).toBe("C:\\");
    expect(parentOf("C:\\")).toBeNull();
    expect(parentOf("/a")).toBe("/");
    expect(parentOf("/")).toBeNull();
    expect(parentOf("\\\\srv\\share\\a")).toBe("\\\\srv\\share\\");
    expect(parentOf("\\\\srv\\share\\")).toBeNull();
  });

  it("goes up from a drive root to This PC only", () => {
    expect(upTarget("C:\\")).toBe(THIS_PC);
    expect(upTarget("C:\\a")).toBe("C:\\");
    expect(upTarget("/")).toBeNull();
    expect(upTarget("\\\\srv\\share\\")).toBeNull();
    expect(upTarget(THIS_PC)).toBeNull();
  });

  it("recognises roots", () => {
    expect(isRootPath("C:\\")).toBe(true);
    expect(isRootPath("/")).toBe(true);
    expect(isRootPath("C:\\a")).toBe(false);
    expect(isRootPath(THIS_PC)).toBe(true);
  });

  it("builds the expansion chain for the folder tree", () => {
    expect(localExpansionChain("C:\\Users\\me")).toEqual([
      "C:\\",
      "C:\\Users",
      "C:\\Users\\me",
    ]);
    expect(localExpansionChain("/a/b")).toEqual(["/", "/a", "/a/b"]);
  });

  it("reads the drive letter", () => {
    expect(driveLetterOf("d:\\x")).toBe("D");
    expect(driveLetterOf("/x")).toBeNull();
  });
});

describe("normalizeTypedPath", () => {
  const win = (s: string) => normalizeTypedPath(s, "C:\\Users\\me", "\\");
  const nix = (s: string) => normalizeTypedPath(s, "/home/me", "/");

  it("turns a bare letter into a drive root", () => {
    expect(win("d")).toBe("D:\\");
    expect(win("d:")).toBe("D:\\");
    expect(win(" e:\\ ")).toBe("E:\\");
  });

  it("fixes slashes, case of the letter and trailing separators", () => {
    expect(win("c:/users//me/")).toBe("C:\\users\\me");
    expect(win('"d:\\My Files"')).toBe("D:\\My Files");
  });

  it("expands the home shortcut", () => {
    expect(win("~")).toBe("C:\\Users\\me");
    expect(win("~/Desktop")).toBe("C:\\Users\\me\\Desktop");
    expect(nix("~/src")).toBe("/home/me/src");
  });

  it("keeps UNC paths intact", () => {
    expect(win("\\\\srv\\share\\a\\")).toBe("\\\\srv\\share\\a");
    expect(win("//srv/share")).toBe("\\\\srv\\share\\");
  });

  it("accepts This PC", () => {
    expect(win("this pc")).toBe(THIS_PC);
  });

  it("leaves POSIX paths alone apart from trailing slashes", () => {
    expect(nix("/etc/")).toBe("/etc");
    expect(nix("/")).toBe("/");
    expect(nix("")).toBe("");
  });

  it("canonicalises the drive letter", () => {
    expect(canonicalLocalPath("c:\\a\\")).toBe("C:\\a");
  });
});

describe("mergeRoots", () => {
  it("matches letters whatever the returned format and sorts them", () => {
    expect(mergeRoots(["d:/", "C:\\", "D:\\"])).toEqual(["C:\\", "D:\\"]);
  });

  it("appends other roots after the drives without duplicates", () => {
    expect(
      mergeRoots(["E:\\"], ["\\\\srv\\share\\a", "\\\\srv\\share\\", "C:\\x"]),
    ).toEqual(["C:\\", "E:\\", "\\\\srv\\share\\"]);
  });
});

describe("createDriveProbe", () => {
  it("probes every letter in one batched call and caches the answer", async () => {
    const exists = vi.fn(async (paths: string[]) =>
      paths.filter((p) => p === "C:\\" || p === "D:\\"),
    );
    const probe = createDriveProbe(exists);
    expect(probe.peek()).toBeNull();
    expect(await probe.get()).toEqual(["C:\\", "D:\\"]);
    expect(await probe.get()).toEqual(["C:\\", "D:\\"]);
    expect(exists).toHaveBeenCalledTimes(1);
    expect(exists.mock.calls[0][0]).toEqual(driveCandidates());
    expect(exists.mock.calls[0][0]).toHaveLength(26);
    expect(probe.peek()).toEqual(["C:\\", "D:\\"]);
  });

  it("shares one pending probe between concurrent callers", async () => {
    const exists = vi.fn(async () => ["C:\\"]);
    const probe = createDriveProbe(exists);
    await Promise.all([probe.get(), probe.get(), probe.get()]);
    expect(exists).toHaveBeenCalledTimes(1);
  });

  it("probes again after the ttl or when forced", async () => {
    let t = 0;
    const exists = vi.fn(async () => ["C:\\"]);
    const probe = createDriveProbe(exists, { ttlMs: 1000, now: () => t });
    await probe.get();
    t = 500;
    await probe.get();
    expect(exists).toHaveBeenCalledTimes(1);
    t = 1500;
    await probe.get();
    expect(exists).toHaveBeenCalledTimes(2);
    await probe.get(true);
    expect(exists).toHaveBeenCalledTimes(3);
  });

  it("falls back to known roots on failure and does not cache it", async () => {
    const exists = vi
      .fn<(paths: string[]) => Promise<string[]>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(["C:\\", "F:\\"]);
    const probe = createDriveProbe(exists, { known: () => ["c:\\users"] });
    expect(await probe.get()).toEqual(["C:\\"]);
    expect(probe.peek()).toBeNull();
    expect(await probe.get()).toEqual(["C:\\", "F:\\"]);
  });

  it("gives up on a stalled probe", async () => {
    const exists = vi.fn(() => new Promise<string[]>(() => {}));
    const probe = createDriveProbe(exists, {
      known: () => ["D:\\"],
      timeoutMs: 10,
    });
    expect(await probe.get()).toEqual(["D:\\"]);
  });

  it("folds roots learned later into a cached answer", async () => {
    let extra: string[] = [];
    const probe = createDriveProbe(async () => ["C:\\"], {
      known: () => extra,
    });
    await probe.get();
    extra = ["Z:\\"];
    expect(await probe.get()).toEqual(["C:\\", "Z:\\"]);
  });
});

describe("rememberRoot", () => {
  it("moves the root to the front, unique and capped", () => {
    expect(rememberRoot(["D:\\", "E:\\"], "e:\\x")).toEqual(["E:\\", "D:\\"]);
    expect(rememberRoot([], "\\\\srv\\share\\a")).toEqual(["\\\\srv\\share\\"]);
    expect(rememberRoot(["A:\\", "B:\\"], "C:\\", 2)).toEqual(["C:\\", "A:\\"]);
  });

  it("ignores the POSIX root and relative paths", () => {
    expect(rememberRoot(["D:\\"], "/usr")).toEqual(["D:\\"]);
    expect(rememberRoot(["D:\\"], "rel/x")).toEqual(["D:\\"]);
  });
});

describe("shortcuts", () => {
  it("lists candidates under home, OneDrive after the plain folder", () => {
    const c = shortcutCandidates("C:\\Users\\me\\", "\\");
    const desktop = c.find((x) => x.id === "desktop")!;
    expect(desktop.candidates[0]).toBe("C:\\Users\\me\\Desktop");
    expect(desktop.candidates).toContain("C:\\Users\\me\\OneDrive\\Desktop");
    expect(c.find((x) => x.id === "downloads")!.candidates).toEqual([
      "C:\\Users\\me\\Downloads",
    ]);
  });

  it("resolves the folders that exist with one exists call", async () => {
    const exists = vi.fn(async (paths: string[]) =>
      paths.filter((p) =>
        ["C:\\Users\\me\\Downloads", "C:\\Users\\me\\Documents"].includes(p),
      ),
    );
    const out = await resolveShortcuts("C:\\Users\\me", "\\", exists);
    expect(exists).toHaveBeenCalledTimes(1);
    expect(out).toEqual([
      { id: "home", path: "C:\\Users\\me" },
      { id: "documents", path: "C:\\Users\\me\\Documents" },
      { id: "downloads", path: "C:\\Users\\me\\Downloads" },
    ]);
  });

  it("prefers the OneDrive copy when only that exists, case-blind on Windows", async () => {
    const exists = async () => ["c:\\users\\me\\onedrive\\desktop"];
    const out = await resolveShortcuts("C:\\Users\\me", "\\", exists);
    expect(out.find((s) => s.id === "desktop")?.path).toBe(
      "C:\\Users\\me\\OneDrive\\Desktop",
    );
  });

  it("works on POSIX and is case-sensitive there", async () => {
    const exists = async () => ["/home/me/Desktop", "/home/me/downloads"];
    const out = await resolveShortcuts("/home/me", "/", exists);
    expect(out.map((s) => s.id)).toEqual(["home", "desktop"]);
  });

  it("still offers Home when the lookup fails", async () => {
    const out = await resolveShortcuts("/home/me", "/", async () => {
      throw new Error("no");
    });
    expect(out).toEqual([{ id: "home", path: "/home/me" }]);
  });
});

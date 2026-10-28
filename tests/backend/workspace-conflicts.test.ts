import { describe, expect, it } from "vitest";
import {
  baseName,
  findConflicts,
  keepBothName,
  keepBothNames,
  parentPath,
  planConflicts,
  resolveAll,
  resolveOne,
  uniqueName,
} from "../../src/frontend/workspace/conflicts";

describe("keepBothName", () => {
  it("previews the name Keep both gives an item", () => {
    expect(keepBothName({ name: "report.txt", isDirectory: false })).toBe(
      "report (2).txt",
    );
    expect(keepBothName({ name: "dir.d", isDirectory: true })).toBe(
      "dir.d (2)",
    );
  });
});

describe("keepBothNames", () => {
  const file = (name: string) => ({ name, isDirectory: false });
  const dir = (name: string) => ({ name, isDirectory: true });

  it("skips numbers that already exist at the destination", () => {
    const sources = [file("a.txt"), file("b.txt")];
    const names = keepBothNames(
      sources,
      ["a.txt", "a (2).txt", "a (3).txt", "b.txt"],
      sources,
    );
    expect(names).toEqual({ "a.txt": "a (4).txt", "b.txt": "b (2).txt" });
  });

  it("also avoids names of the other items in the same batch", () => {
    const sources = [file("a.txt"), file("a (2).txt"), dir("d")];
    const names = keepBothNames(
      sources,
      ["a.txt", "d"],
      [sources[0], sources[2]],
    );
    expect(names).toEqual({ "a.txt": "a (3).txt", d: "d (2)" });
  });

  it("tip equals the real rename when every asked item keeps both", () => {
    const sources = [file("x.tar.gz"), file("y"), dir("z.d"), file("y (2)")];
    const existing = ["x.tar.gz", "x (2).tar.gz", "y", "z.d", "z.d (2)"];
    const asking = findConflicts(sources, existing);
    const tips = keepBothNames(sources, existing, asking);
    const decisions = Object.fromEntries(
      asking.map((i) => [i.name, "rename" as const]),
    );
    const plan = planConflicts(sources, existing, decisions);
    for (const item of asking)
      expect(tips[item.name]).toBe(plan.renames[item.name]);
    expect(tips).toEqual({
      "x.tar.gz": "x (3).tar.gz",
      y: "y (3)",
      "z.d": "z.d (3)",
    });
  });

  it("counts renames made for the same-folder copy of other items", () => {
    const sources = [file("a.txt"), file("b.txt")];
    const options = { selfNames: new Set(["b.txt"]), move: false };
    const names = keepBothNames(sources, ["a.txt"], [sources[0]], options);
    expect(names).toEqual({ "a.txt": "a (2).txt" });
    expect(
      planConflicts(sources, ["a.txt"], { "a.txt": "rename" }, options).renames,
    ).toEqual({ "a.txt": "a (2).txt", "b.txt": "b (2).txt" });
  });

  it("keeps characters such as & and < untouched", () => {
    const sources = [file("R&D <1>.txt")];
    expect(keepBothNames(sources, ["R&D <1>.txt"], sources)).toEqual({
      "R&D <1>.txt": "R&D <1> (2).txt",
    });
  });
});

describe("uniqueName", () => {
  it("keeps the extension and counts from 2", () => {
    expect(uniqueName("a.txt", () => false)).toBe("a (2).txt");
    expect(uniqueName("a.txt", (c) => c === "a (2).txt")).toBe("a (3).txt");
    expect(uniqueName("x.tar.gz", () => false)).toBe("x (2).tar.gz");
    expect(uniqueName("dir.d", () => false, true)).toBe("dir.d (2)");
    expect(uniqueName("Makefile", () => false)).toBe("Makefile (2)");
  });
});

describe("paths", () => {
  it("splits paths", () => {
    expect(baseName("/a/b/")).toBe("b");
    expect(parentPath("/a/b")).toBe("/a");
    expect(parentPath("/a")).toBe("/");
  });
});

const src = (name: string, isDirectory = false) => ({ name, isDirectory });

describe("planConflicts", () => {
  it("finds conflicts", () => {
    expect(findConflicts([src("a"), src("b")], ["b", "c"])).toEqual([src("b")]);
  });

  it("does nothing without conflicts", () => {
    expect(planConflicts([src("a")], ["b"], {})).toEqual({
      renames: {},
      skip: [],
      count: 1,
    });
  });

  it("applies replace, skip and rename", () => {
    const plan = planConflicts(
      [src("a.txt"), src("b.txt"), src("c.txt")],
      ["a.txt", "b.txt", "c.txt", "c (2).txt"],
      { "a.txt": "replace", "b.txt": "skip", "c.txt": "rename" },
    );
    expect(plan.skip).toEqual(["b.txt"]);
    expect(plan.renames).toEqual({ "c.txt": "c (3).txt" });
    expect(plan.count).toBe(2);
  });

  it("keeps renames of several items distinct", () => {
    const plan = planConflicts([src("a.txt"), src("a (2).txt")], ["a.txt"], {
      "a.txt": "rename",
    });
    expect(plan.renames["a.txt"]).toBe("a (3).txt");
  });

  it("copy into the same folder keeps both, move skips", () => {
    const self = new Set(["a.txt"]);
    const copy = planConflicts(
      [src("a.txt")],
      ["a.txt"],
      {},
      { selfNames: self },
    );
    expect(copy.renames).toEqual({ "a.txt": "a (2).txt" });
    const move = planConflicts(
      [src("a.txt")],
      ["a.txt"],
      {},
      { selfNames: self, move: true },
    );
    expect(move.skip).toEqual(["a.txt"]);
    expect(move.count).toBe(0);
  });
});

describe("resolveOne / resolveAll", () => {
  const items = [
    { name: "a", isDirectory: false },
    { name: "b", isDirectory: true },
    { name: "c", isDirectory: false },
  ];
  const start = { pending: items, decisions: {} };

  it("resolves one item and removes it from pending", () => {
    const next = resolveOne(start, "b", "skip");
    expect(next.pending.map((i) => i.name)).toEqual(["a", "c"]);
    expect(next.decisions).toEqual({ b: "skip" });
    expect(start.pending).toHaveLength(3);
  });

  it("ignores unknown names", () => {
    expect(resolveOne(start, "zzz", "skip")).toBe(start);
  });

  it("resolves all remaining and keeps earlier decisions", () => {
    const next = resolveAll(resolveOne(start, "a", "replace"), "rename");
    expect(next.pending).toEqual([]);
    expect(next.decisions).toEqual({ a: "replace", b: "rename", c: "rename" });
  });
});

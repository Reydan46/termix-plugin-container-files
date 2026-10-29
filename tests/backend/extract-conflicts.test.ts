import { describe, expect, it } from "vitest";
import {
  extractQuestions,
  planExtraction,
} from "../../src/frontend/extractConflicts";

const file = (name: string) => ({ name, isDirectory: false });
const dir = (name: string) => ({ name, isDirectory: true });

describe("extractQuestions", () => {
  it("asks only about names that already exist", () => {
    const items = [file("a.txt"), dir("src"), file("new.txt")];
    const { asking, renamed } = extractQuestions(items, ["a.txt", "src", "z"]);
    expect(asking.map((i) => i.name)).toEqual(["a.txt", "src"]);
    expect(renamed).toEqual({ "a.txt": "a (2).txt", src: "src (2)" });
  });

  it("asks nothing when the folder has none of the names", () => {
    expect(extractQuestions([file("a")], ["b"])).toEqual({
      asking: [],
      renamed: {},
    });
  });

  it("previews keep both with names that are really free", () => {
    const items = [file("a.txt"), file("a (2).txt")];
    const { renamed } = extractQuestions(items, ["a.txt", "a (2).txt"]);
    expect(renamed["a.txt"]).toBe("a (3).txt");
    expect(renamed["a (2).txt"]).toBe("a (2) (2).txt");
  });
});

describe("planExtraction", () => {
  const items = [file("a.txt"), file("b.txt"), dir("d"), file("c.txt")];
  const existing = ["a.txt", "b.txt", "d"];

  it("has no choices when every conflict is replaced (plain overwrite)", () => {
    expect(planExtraction(items, existing, {})).toEqual({
      count: 4,
      choices: null,
    });
    expect(
      planExtraction(items, existing, { "a.txt": "replace", d: "replace" }),
    ).toEqual({ count: 4, choices: null });
  });

  it("sends skips and renames per item", () => {
    expect(
      planExtraction(items, existing, {
        "a.txt": "skip",
        "b.txt": "rename",
        d: "replace",
      }),
    ).toEqual({
      count: 3,
      choices: {
        skip: ["a.txt"],
        renames: { "b.txt": "b (2).txt" },
        replace: ["d"],
      },
    });
  });

  it("apply to all as skip leaves only the new items", () => {
    const run = planExtraction(items, existing, {
      "a.txt": "skip",
      "b.txt": "skip",
      d: "skip",
    });
    expect(run.count).toBe(1);
    expect(run.choices?.skip).toEqual(["a.txt", "b.txt", "d"]);
  });

  it("counts zero when everything is skipped", () => {
    const only = [file("a.txt")];
    expect(planExtraction(only, ["a.txt"], { "a.txt": "skip" }).count).toBe(0);
  });

  it("ignores decisions for names that do not clash", () => {
    expect(planExtraction(items, existing, { "c.txt": "skip" })).toEqual({
      count: 4,
      choices: null,
    });
  });

  it("keeps a folder rename away from names taken by siblings", () => {
    const run = planExtraction([dir("x"), dir("x (2)")], ["x", "x (2)"], {
      x: "rename",
    });
    expect(run.choices?.renames).toEqual({ x: "x (3)" });
  });
});

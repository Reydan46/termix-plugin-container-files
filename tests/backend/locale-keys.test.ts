import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const en = JSON.parse(readFileSync("locales/en.json", "utf8"));
const ru = JSON.parse(readFileSync("locales/translated/ru_RU.json", "utf8"));

const at = (tree: unknown, key: string) =>
  key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      tree,
    );

// A key with a count is stored as its plural forms (key_one, key_other, ...).
const has = (tree: unknown, key: string) =>
  at(tree, key) !== undefined || at(tree, `${key}_other`) !== undefined;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "vendor") return [];
    return statSync(path).isDirectory() ? sources(path) : [path];
  });
}

describe("translation keys used by the plugin's own frontend", () => {
  const keys = new Set<string>();
  for (const file of sources("src/frontend")) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\bt\(\s*"([A-Za-z][\w.]*\.[\w.]+)"/g))
      keys.add(m[1]);
  }

  it("finds the keys", () => {
    expect(keys.size).toBeGreaterThan(50);
  });

  it("all exist in English", () => {
    expect([...keys].filter((k) => !has(en, k))).toEqual([]);
  });

  it("all exist in Russian", () => {
    expect([...keys].filter((k) => !has(ru, k))).toEqual([]);
  });
});

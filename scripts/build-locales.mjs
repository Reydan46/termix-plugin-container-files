#!/usr/bin/env node
// locales/<file>.json = vendor/locales/file-manager.<lang>.json (sections the
// vendored code reads) + locales-src/<lang>.json (this plugin's own keys, which win).
// Termix reads English from locales/en.json and every other language from
// locales/translated/<file>.json, where <file> is its locale code (ru -> ru_RU).
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);
const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
const merge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b))
    out[k] =
      v && typeof v === "object" && !Array.isArray(v)
        ? merge(out[k] && typeof out[k] === "object" ? out[k] : {}, v)
        : v;
  return out;
};
const files = { en: "en.json", ru: "translated/ru_RU.json" };
// A leftover from before translations moved to translated/.
rmSync(join(root, "locales/ru.json"), { force: true });
for (const lang of ["en", "ru"]) {
  const upstream = read(join(root, `vendor/locales/file-manager.${lang}.json`));
  const fallback =
    lang === "en"
      ? {}
      : read(join(root, "vendor/locales/file-manager.en.json"));
  const own = read(join(root, `locales-src/${lang}.json`));
  const merged = merge(merge(fallback, upstream), own);
  const out = join(root, "locales", files[lang]);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(merged, null, 2) + "\n");
  console.log(`locales/${files[lang]} written`);
}

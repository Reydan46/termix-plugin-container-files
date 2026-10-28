#!/usr/bin/env node
// locales/<lang>.json = vendor/locales/file-manager.<lang>.json (sections the
// vendored code reads) + locales-src/<lang>.json (this plugin's own keys, which win).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
for (const lang of ["en", "ru"]) {
  const upstream = read(join(root, `vendor/locales/file-manager.${lang}.json`));
  const fallback =
    lang === "en"
      ? {}
      : read(join(root, "vendor/locales/file-manager.en.json"));
  const own = read(join(root, `locales-src/${lang}.json`));
  const merged = merge(merge(fallback, upstream), own);
  writeFileSync(
    join(root, `locales/${lang}.json`),
    JSON.stringify(merged, null, 2) + "\n",
  );
  console.log(`locales/${lang}.json written`);
}

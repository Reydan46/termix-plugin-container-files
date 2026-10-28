#!/usr/bin/env node
// Keeps vendored copies of upstream plugin files byte-identical to upstream.
//   node scripts/sync-upstream.mjs <source> [--ref <commit|tag|branch>] [--check]
// --check  : report files that differ from the pinned (or --ref) upstream; changes nothing.
// default  : copy files, re-apply vendor/patches/<source>/*.patch, update vendor/UPSTREAM.lock.json.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);
const args = process.argv.slice(2);
const name = args.find(
  (a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--ref",
);
const check = args.includes("--check");
const refIdx = args.indexOf("--ref");
const ref = refIdx >= 0 ? args[refIdx + 1] : undefined;

const config = JSON.parse(
  readFileSync(join(root, "vendor/upstream.config.json"), "utf8"),
);
const lockPath = join(root, "vendor/UPSTREAM.lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const source = config.sources.find((s) => s.name === name);
if (!source) {
  console.error(
    `usage: sync-upstream <${config.sources.map((s) => s.name).join("|")}> [--ref X] [--check]`,
  );
  process.exit(2);
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const git = (cwd, ...a) =>
  execFileSync("git", a, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

const tmp = mkdtempSync(join(tmpdir(), `sync-${name}-`));
try {
  execFileSync("git", ["clone", "-q", source.repo, tmp], { stdio: "inherit" });
  const target = ref ?? lock[name].commit;
  git(tmp, "checkout", "-q", target);
  const commit = git(tmp, "rev-parse", "HEAD");
  const changed = [];
  const missing = [];
  const next = {};
  for (const file of source.files) {
    const from = join(tmp, source.srcRoot, file);
    if (!existsSync(from)) {
      missing.push(file);
      continue;
    }
    const data = readFileSync(from);
    next[file] = sha(data);
    if (lock[name].files[file] !== next[file]) changed.push(file);
  }
  console.log(
    `${name}: pinned ${lock[name].commit.slice(0, 8)} -> ${commit.slice(0, 8)}`,
  );
  for (const f of changed) console.log(`  changed upstream: ${f}`);
  for (const f of missing) console.log(`  MISSING upstream: ${f}`);
  if (!changed.length && !missing.length)
    console.log("  vendored files match upstream");
  if (check) process.exit(missing.length ? 1 : 0);

  const dest = join(root, source.dest);
  for (const file of source.files) {
    if (missing.includes(file)) continue;
    mkdirSync(dirname(join(dest, file)), { recursive: true });
    cpSync(join(tmp, source.srcRoot, file), join(dest, file));
  }
  if (source.locales) {
    // Only the sections the vendored code reads; build-locales.mjs merges them.
    mkdirSync(join(root, "vendor/locales"), { recursive: true });
    for (const [lang, rel] of Object.entries(source.locales.files)) {
      const from = join(tmp, rel);
      if (!existsSync(from)) continue;
      const all = JSON.parse(readFileSync(from, "utf8"));
      const picked = {};
      for (const section of source.locales.sections)
        if (all[section]) picked[section] = all[section];
      writeFileSync(
        join(root, `vendor/locales/${name}.${lang}.json`),
        JSON.stringify(picked, null, 2) + "\n",
      );
    }
  }
  const patchDir = join(root, source.patches);
  if (existsSync(patchDir)) {
    for (const p of readdirSync(patchDir)
      .filter((f) => f.endsWith(".patch"))
      .sort()) {
      try {
        execFileSync(
          "git",
          ["apply", "--directory", source.dest, join(patchDir, p)],
          { cwd: root, stdio: "inherit" },
        );
        console.log(`  applied ${p}`);
      } catch {
        console.error(
          `  PATCH CONFLICT: ${p} - rebase it against the new upstream`,
        );
        process.exitCode = 1;
      }
    }
  }
  lock[name] = { commit, files: next };
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  if (missing.length) process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

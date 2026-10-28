# Architecture

## Backend (`src/backend`)

An Express router served by the Termix plugin backend.

- `index.ts`, `routes.ts`, `routes-transfer-extra.ts`: HTTP routes (SSH session, containers, `fs/*` operations, transfers, container-to-container copy, desktop local transfers).
- `sessions.ts`, `connect.ts`: per-user SSH sessions on top of host credentials.
- `containers.ts`, `runtime.ts`, `capabilities.ts`: engine detection (docker/podman) and a per-container capability probe (`exec`, `findPrintf`, `statC`, missing tools, machine-readable `reason`).
- `exec.ts`: `openChannel`, `openChannelAbortable` (a cancel during channel open destroys the channel once it opens), `runCommand`, `channelDone`.
- `fs-list.ts`, `fs-ops.ts`, `fs-read-write.ts`, `archive.ts`: listing in tiers, operations, editor read/write, archive browse/extract/compress.
- `cp-io.ts`, `channel-stream.ts`, `tar.ts`: `docker cp` streaming. `sanitizeTar` re-packs a tar stream, rejects traversal, absolute names, escaping symlinks and devices, applies owner and top-level renames. Hard links are kept only with `allowHardlinks` (container copy).
- `transfers.ts`, `c2c.ts`, `local-transfer.ts`, `tar-local.ts`, `op-progress.ts`: transfer registry (progress, cancel), uploads and downloads, relay copy, desktop local transfers.

### Shell-quote rule

Never interpolate values into a script. `execScriptCommand(runtime, id, script, args)` runs `sh -c <script> _ arg1 arg2 ...`: user values (paths, names) reach the script only as positional parameters (`"$1"`, `"$@"`). Every argument of the engine command is quoted by `shq` (via `engineCommand`). Scripts are constants.

### Temporary names

Single-file uploads and container copies write `.cf-part-<id8>-<name>` (`partName` in `helpers.ts`: at most 255 bytes, extension preserved, a short hash when shortened), then `mv` it into place; failures remove it. Listings hide `.cf-part-` entries. Container copy writes in place when the target name already exists (merge semantics of `cp`) and when the target has no shell.

## Frontend (`src/frontend`)

- `index.tsx`, `ContainerFilesTab.tsx`: tab, host and container selection, connect flow.
- `ContainerFileManager.tsx`: the orchestrator for one container (see [orchestrator-parity.md](orchestrator-parity.md)).
- `containerFsApi.ts`: typed client for the backend; `webTransfer.ts`: browser upload and streaming helpers.
- `popup/`: shared draggable popup windows, confirm, placement.
- `workspace/`: tiled panes, drag and drop between panes, conflict window, transfer queue (the Desktop local pane lives here).
- Windows: archive, compress, extract, permissions, symlink, path picker.
- `vendor/file-manager/`: UI copied from Plugin-File-Manager.

## Vendored UI and patches

`vendor/upstream.config.json` lists the upstream repo, the files to copy and the locale sections. `vendor/UPSTREAM.lock.json` pins the commit and per-file hashes. Vendored files must stay identical to upstream except through `vendor/patches/file-manager/NNNN-*.patch`.

```
node scripts/sync-upstream.mjs file-manager --check   # report drift, change nothing
node scripts/sync-upstream.mjs file-manager           # re-copy at the pinned ref, re-apply patches, update lock
node scripts/sync-upstream.mjs file-manager --ref <commit|tag|branch>
```

### Adding a patch

1. Edit the vendored file under `src/frontend/vendor/file-manager/`.
2. Save the change as a git-format diff with paths relative to the vendor root (for example `hooks/usePaneWidth.ts`) under the next number, e.g. `vendor/patches/file-manager/0018-name.patch`.
3. Run `node scripts/sync-upstream.mjs file-manager`; `git status` must show only the patched files changed, and `--check` must pass.

## Locales

Edit `locales-src/{en,ru}.json` (interpolation `{{name}}`), then run `node scripts/build-locales.mjs`. It merges the upstream sections from `vendor/locales` with the plugin's own keys (own keys win) into `locales/`.

## Tests

`tests/backend` uses vitest with `fake-ssh.ts`, a fake ssh2 client that answers by command pattern. No Docker is needed.

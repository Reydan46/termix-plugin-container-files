# Architecture

## Backend (`src/backend`)

An Express router served by the Termix plugin backend.

- `index.ts`, `routes.ts`, `routes-transfer-extra.ts`: HTTP routes (SSH session, containers, `fs/*` operations, transfers, container-to-container copy, desktop local transfers).
- `sessions.ts`, `connect.ts`: per-user SSH sessions on top of host credentials.
- `containers.ts`, `runtime.ts`, `capabilities.ts`: engine detection (docker/podman) and a per-container capability probe (`exec`, `findPrintf`, `statC`, missing tools, machine-readable `reason`).
- `exec.ts`: `openChannel`, `openChannelAbortable` (a cancel during channel open destroys the channel once it opens), `runCommand`, `channelDone`.
- `mounts.ts`: `GET .../mounts`, the container mounts from `inspect --format {{json .Mounts}}` (docker and podman shapes, cached briefly in the session and dropped with the container state). The UI badges mount destinations (patch 0022) and lists them in the Mounts window.
- `archive-append.ts`: the `append` op (add files to an existing archive). One constant script works on a `.cf-part-` copy next to the archive (`zip -g`, `tar -r`, `7z a`; compressed tars are decompressed to a temporary tar, appended and recompressed) and `mv`s it over the original, keeping mode and owner; a trap and a backend `rm` remove the temp files on failure or cancel. Missing capabilities give `APPEND_UNSUPPORTED` with a `reason`. The UI uses it from the context menu and from dropping on an archive file (patch 0023 adds the `fileDropHint` / `onDropOnFile` hooks to the grid).
- `archive-delete.ts`: the `archive-delete` op (remove entries from an archive). Same atomic shape as append: one constant script rewrites a `.cf-part-` copy (`zip -d`, `7z d`, GNU `tar --delete`; compressed tars are decompressed to a temporary tar, edited and recompressed), `mv -f`s it over the original keeping mode and owner, and a trap plus a backend `rm` clean up on failure or cancel. Entry names are positional arguments; names with pattern characters (`* ? [`) are refused as `UNSUPPORTED_NAME`, and a result with no entries as `ARCHIVE_WOULD_BE_EMPTY`. rar and single compressed files give `DELETE_UNSUPPORTED` with a `reason`. The probe adds `deleteSupport` (per kind, like `appendSupport`) so the UI explains up front.
- `archive-kinds.ts` (backend) and `src/frontend/archiveKinds.ts`: one table of archive extensions to a kind (zip and its aliases, tar family, tzst, 7z, rar, single-file gz/bz2/xz/zst) and the tools each kind needs; a test keeps the two copies in step. `archive.ts` lists 7z with `7z l -slt` and rar with `unrar` (or 7-Zip, or bsdtar), reads one entry with `7z e -so`, and refuses single-file kinds as `NOT_BROWSABLE`; `fs-ops.ts` extracts them all, with bsdtar as the fallback for whole-archive extraction. A missing tool is `NO_TOOL` (501, `details.tool`), worded "<tool> is not installed in this container". All of this is unit-tested through command construction only; it has not been run against real containers with those tools.
- `fs-list.ts`, `fs-ops.ts`, `fs-read-write.ts`, `archive.ts`: listing in tiers, operations, editor read/write, archive browse/extract/compress.
- `cp-io.ts`, `channel-stream.ts`, `tar.ts`: `docker cp` streaming. `sanitizeTar` re-packs a tar stream, rejects traversal, absolute names, escaping symlinks and devices, applies owner and top-level renames. Hard links are kept only with `allowHardlinks` (container copy).
- `transfers.ts`, `c2c.ts`, `local-transfer.ts`, `tar-local.ts`, `op-progress.ts`: transfer registry (progress, cancel), uploads and downloads, relay copy, desktop local transfers.
- `remote-proxy.ts`, `remote-side.ts`: server-origin proxy and remote halves of local transfers.

### Connection origin

Termix Desktop hosts can start connections from this device or from the linked server. A session id with the `cfr-` prefix marks a server-origin session (`cf-` is local); `src/frontend/sessionOrigin.ts` derives the origin from it and `via()` prefixes API urls with `/remote`. On the local backend `remote-proxy.ts` forwards `/remote/*` to the same plugin on the server through `ctx.desktop.local.pluginFetch("remote", ...)`, streaming both ways. The container console connects its WebSocket directly to the session's origin. The desktop host is mapped to the server host with `resolveRemoteHostId`; if the desktop is not linked, the host is not synced or the plugin is missing on the server, the UI shows a blocking message with Retry instead of falling back to local.

Transfers between the local pane and a container in a server-origin session are split in halves (`remote-side.ts`): the local filesystem is handled by the local backend and the container side goes through `pluginFetch` to the server's existing transfer routes. Container-to-container copy never crosses origins. Credentials typed in the SSH auth dialog travel from the renderer over the local backend to the server.

### OS clipboard

Explorer to container, Web: a `paste` event on the active pane whose `clipboardData.files` is not empty uploads them into the current or single selected folder through the normal upload path (`osClipboard.ts`; files only, a folder arrives unreadable). The OS clipboard has no timestamp, so the internal clipboard wins only if it was set after the window last regained focus. Explorer to container, Desktop on Windows: the SDK gives a plugin no clipboard API (`window.electronClipboard` is text only) and the webview may not deliver files in a paste event, so Ctrl+V (matched by `event.code`, so any keyboard layout works) is handled on keydown. `/local/clipboard/read` runs `Get-Clipboard -Format FileDropList` in a local PowerShell pty and returns `{path, isDirectory}` entries (`own` is true when they are the plugin's own temp copy, which pastes the internal clipboard instead); `PaneBridge.pasteLocalPaths` then uploads them with the same local to container transfer as a drop from the local pane, files and folders, direct and via-server origins alike. Container to Explorer (Desktop on Windows only): Copy also downloads the items with `/local/transfer/download` (both origins) to a `termix-cf-clip-*` temp directory, up to 512 MB, then `/local/clipboard/set` runs `Set-Clipboard -LiteralPath` over the entries of that directory. PowerShell is the only way a plugin can reach the file clipboard: `ctx.desktop.local` offers files and a pty only, so each script is sent as `powershell -NoProfile -NonInteractive -STA -EncodedCommand` (paths and results travel as base64, markers are assembled at run time so the echoed command never matches, `os-clipboard.ts`). Windows PowerShell 5.1 does not unroll `@(<json> | ConvertFrom-Json)`, so lists are built with `@(Get-ChildItem ...)` instead. Every failure carries a code (`CLIP_SPAWN`, `CLIP_TIMEOUT`, `CLIP_EXIT`, `CLIP_SCRIPT`, `UNSUPPORTED`, `NOT_DESKTOP`) and the reason; `osClipboardErrors.ts` maps them to the toast text, so no Desktop step fails silently. The previous temp copy is removed on the next Copy and on exit. The newest Copy owns every clipboard: each Copy or Cut in any pane (`ContainerWorkspace.putClip`, container panes and the local pane alike) stamps `markInternalClipboard`, cancels a still running OS copy (`supersedeOsCopy`) so a slow older one cannot land after it, and the local pane's Copy lists its real paths on the Windows clipboard (`/local/clipboard/set-paths`, `Set-Clipboard -LiteralPath`, nothing is copied) and drops the old temp copy. A Ctrl+V whose Explorer files are the internal clipboard's own local paths (`samePaths`) pastes the internal clipboard, not an upload. Pasting in the local pane first checks for a newer Explorer copy (`pasteIntoLocal`). The shortcuts of the grid (patch 0030) and the local pane use `layoutKey`, which maps Ctrl/Cmd plus a non-Latin letter to its physical key, so Copy, Cut and Paste work on any keyboard layout. Checked against a real Windows PowerShell 5.1 only in isolation; not yet in Termix Desktop with Explorer.

### Extract conflicts

Extracting into a folder that already holds some of the names uses the conflict window of the transfers (`workspace/useConflictWindow.tsx`: replace, skip or keep both, per item or for all, cancel), not a yes/no confirm. `useArchiveExtract` (whole archive or chosen entries, both origins, same routes) asks `fs/extract-plan` for the top level names the extraction creates (`extract-policy.ts`, from `listArchive`), lists the destination, and `extractConflicts.ts` (built on `planConflicts`) turns the answers into `skip` (names to leave out) and `renames` (name to new name). With no conflicts it extracts without overwrite; when every conflict is "replace" it extracts with `overwrite: true`, as before; otherwise `extract` / `extract-entries` take `skip` and `renames`. Those are applied by `extractWithPolicy`: the archive extracts into a `.cf-extract-<id>` folder inside the destination (the existing scripts run unchanged, with overwrite), then `PLACE_SCRIPT` drops the skipped names, moves renamed ones (exit 17 if the new name is taken), replaces the rest (a folder merges) and removes the stage; the stage is also removed by the backend when the extraction fails or is cancelled. Names reach the script only as positional arguments. A server without `extract-plan` answers 404 without a code, which the client reports as `SERVER_OLDER`; it then falls back to the old flow (extract without overwrite, on `EXISTS` one overwrite-all confirm). Unit-tested, including the placement script on a real `sh`; not exercised yet against a real container from the UI.

### Shell-quote rule

Never interpolate values into a script. `execScriptCommand(runtime, id, script, args)` runs `sh -c <script> _ arg1 arg2 ...`: user values (paths, names) reach the script only as positional parameters (`"$1"`, `"$@"`). Every argument of the engine command is quoted by `shq` (via `engineCommand`). Scripts are constants.

### Temporary names

Single-file uploads and container copies write `.cf-part-<id8>-<name>` (`partName` in `helpers.ts`: at most 255 bytes, extension preserved, a short hash when shortened), then `mv` it into place; failures remove it. Listings hide `.cf-part-` entries. Container copy writes in place when the target name already exists (merge semantics of `cp`) and when the target has no shell.

## Frontend (`src/frontend`)

- `index.tsx`, `ContainerFilesTab.tsx`: tab, host and container selection, connect flow.
- `ContainerFileManager.tsx`: the orchestrator for one container (see [orchestrator-parity.md](orchestrator-parity.md)).
- `containerFsApi.ts`: typed client for the backend; `webTransfer.ts`: browser upload and streaming helpers.
- `popup/`: shared draggable popup windows, confirm, placement. `keyGuard.ts` keeps the file panes out of dialogs: the vendored grid (patch 0027), the local pane and the Escape-clears-clipboard listener listen on `document`, so a key from inside a `.window-container`, dialog or menu, or any key while a confirm card is open, is ignored there (`dialogOwnsKey`). The confirm card (`useConfirm`, rules in `confirmKeys.ts`) is a `window` capture listener that stops every key while it is the topmost card (Enter confirms or cancels by focus, held Enter and other keys are swallowed) and focuses its default button once it is placed (an `autoFocus` does not work while the card is `visibility:hidden`), then returns the focus to where it was.
- `archiveRefresh.ts`: registry that tells open `ArchiveWindow`s to reload. `handleAppend` and `handleArchiveDelete` call `notifyArchiveChanged(containerKey, archive)` after a successful append or delete; each window for that archive reloads its folder without the loading state, keeping scroll and the selection (names that vanished drop out). The backend side is `dropListings` (drops the archive cache after every successful op).
- `workspace/`: tiled panes, drag and drop between panes, conflict window, transfer queue (the Desktop local pane lives here). `clipboard.ts` holds the pure helpers of the one clipboard shared by all panes: cross-pane paste reuses the drag-and-drop transfer, a cut removes the source only after a successful paste, and local to local copy is not supported.
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

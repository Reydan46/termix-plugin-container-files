# Orchestrator parity

`ContainerFileManager.tsx` plays the role of upstream Plugin-File-Manager's `FileManager.tsx`: it owns state (path, listing, selection, clipboard, windows, transfers) and wires the vendored presentation components to a container backend instead of a plain SFTP session. Upstream `FileManager.tsx` itself is not vendored.

## Taken from upstream (vendored, patched where numbered)

- `FileManagerGrid`, `FileManagerToolbar`, `FileManagerContextMenu` (extra items, patch 0008), `FileWindow`, `WindowManager`, `DraggableWindow`, `useFileSelection`, `file-manager-utils` (`runWithConcurrency`), editor and viewer components, `ssh-file-operations-api` (backed by `containerFsApi` here).
- Behaviour kept: selection model, keyboard handling (pane-scoped, patch 0016), drag and drop, column visibility and resizing, list and grid views, viewer routing by file type.

## Replaced or added here

- Backend calls go through `containerFsApi` (HTTP to this plugin), not SFTP; capability messages explain disabled features.
- Confirms and dialogs use the plugin's popup system (`popup/`, patch 0010) rather than upstream dialogs.
- Folder tree, archive browsing and extraction windows, compress window, permissions and owner window, symlink window, status strip.
- Edit gate (size, binary) with a download offer; no external-editor integration (removed, patch 0015).
- Workspace of tiled panes with container-to-container and local transfers (`workspace/`).

## Verification

The mapping is derived from the imports and patches in this repository, not from a line-by-line diff against upstream `FileManager.tsx`. Treat it as a guide; when upstream changes, start with `node scripts/sync-upstream.mjs file-manager --check`.

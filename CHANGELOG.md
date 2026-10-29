# Changelog

## 1.0.2

### Added

- Mounts: mount points are drawn as a blue folder icon with RW or RO lettered inside it in the file list, grid and folder tree, and show where they point (host path, volume or tmpfs). A compact Mounts window lists every mount on one row with its type, destination, source and access, and opens its path (the window then closes). The RW and RO letters are large enough to read at the medium grid size.
- Add files and folders to an existing archive: use "Add to archive..." in the context menu or drop them on an archive file or on an open archive window. Works with zip, 7z, tar, .tar.gz, .tar.bz2, .tar.xz and .tar.zst; the archive is replaced only when the update is complete, with progress and Cancel as for compress. When the container cannot do it (BusyBox tar, or no zip, 7z, gzip, bzip2, xz or zstd), the reason is shown up front, including a "not allowed" cursor and a hint while dragging over the archive.
- Delete entries from inside an archive: select them in the open archive window and use Delete in the context menu or the Delete key, then confirm. Works with zip, 7z and the tar family; the archive is rewritten on a copy and replaced only when it is complete (mode and owner kept), with progress and Cancel. Needs GNU tar for tar archives; a rar or single compressed file, an empty result and a missing tool are refused up front with the reason.
- More archive types are recognised: 7z, rar (browse and extract only), tar.zst and tzst, zip aliases (jar, war, apk, whl, epub and others) and single compressed files (.gz, .bz2, .xz, .zst, extract only). Each needs its tool in the container (7z, 7zz, 7za or 7zr; unrar, 7-Zip or bsdtar for rar; zstd; unzip or bsdtar for zip), and when it is missing the message says so, for example "7z is not installed in this container".
- Dialog keyboard: in every plugin dialog with buttons (confirmations, compress, extract, symlink, permissions, path picker, mounts, conflicts) the button Enter will press is highlighted, the arrow keys move the selection between buttons, and Escape closes the window. Text fields, selects and the editor keep their own keys.
- Clipboard: files copied in Windows Explorer or Finder paste into the active container pane with Ctrl/Cmd+V, with the usual upload progress and conflict questions. In the browser this is files only. In Termix Desktop on Windows, Ctrl+V reads the Explorer clipboard through a local PowerShell and uploads files and folders alike, for hosts connected directly or via the server, and also on a non-Latin keyboard layout. Copy in a container pane also puts the items on the Windows clipboard for Explorer (up to 512 MB, downloaded to a temporary folder that is removed when the app closes). A step that fails shows a message with the reason (for example PowerShell missing, timed out or reporting an error) instead of doing nothing.
- Desktop: copy, cut and paste between the local files pane and container panes with the context menu, toolbar and Ctrl/Cmd+C, X and V. Cut items are dimmed and the originals are removed only after a successful paste. The most recent Copy or Cut always wins, whichever pane or Explorer it came from, and Copy in the local pane also puts the files on the Windows clipboard. The shortcuts work on any keyboard layout.
- Opening a video, audio, image or PDF shows download progress (size, percent) with a Cancel button.

### Changed

- The number of files transferred at once follows the Concurrent transfers setting.
- Error messages and notices that were always shown in English are translated.
- Extracting an archive (all of it or chosen entries) into a folder that already has some of its files asks in the same conflict window as copying between panes: replace, skip or keep both for each item or for all, instead of one overwrite-everything confirm. With an older plugin on the server the old confirm is kept.

### Fixed

- Extracting with conflict choices never overwrites a name you did not choose to replace (a cut-off archive listing falls back to the plain overwrite question), refuses a rename onto another extracted name, and a failure midway lists the items already placed.
- After a Cut from the local pane is pasted, the Windows clipboard no longer lists the moved files; files that vanished since the copy are skipped with a message naming them.

- Hosts set to start connections from the server now connect from the server in the desktop app, including the container console and transfers with the local pane.
- Closing a preview stops its download right away, without an error message, and no longer keeps the file in memory.
- Opening many files at once no longer exhausts the SSH channels of a host: each connection holds at most 6 open, the rest wait their turn, and a refused channel is retried once.
- Browsing inside an archive is faster: the archive is read once and reused for folders and entries.
- A server whose plugin is older than the app now says so (update it) instead of showing a raw error.
- Toggling hidden files in the local pane also reloads collapsed folders of the tree.
- A copy between containers cancelled while its channels were opening now stops both sides.
- Escape during a rubber-band selection drag cancels it and restores the previous selection.
- The Mounts window closes with a Close button instead of Cancel.
- Keys pressed in a confirmation or another dialog no longer reach the file list behind it: Enter on a confirmation (or on a dialog button) used to open the selected file as well. A confirmation now takes the focus as soon as it appears and answers every key itself.

### Removed

- Unused code and the jszip and motion dependencies, which makes the package smaller.

## 1.0.1

### Fixed

- Connection and download error messages in the file window are translated instead of always shown in English.

## 1.0.0

### Added

- Container list per host and a file manager for Docker and Podman containers: list and grid views, folder tree, search, sorting and multi-select.
- Create, rename, copy, cut, paste, delete, symlinks, permissions and owner.
- Text editor and image, audio, video, PDF and Markdown preview.
- Uploads and downloads of files and folders with progress and cancel.
- Compress, extract and browse inside archives.
- Tiled workspace of panes with drag and drop between them, container to container copy and a conflict window.
- Terminal in the container.
- Termix Desktop: a pane with your own computer (drives, shortcuts to your real Desktop, Documents, Downloads and Pictures folders, tree, list and grid views) and drag and drop between it and containers.
- English and Russian.

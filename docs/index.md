**English** · [Русский](index.ru.md)

Container Files is a file manager for Docker and Podman containers. It works over the SSH connection Termix already has to the host, and installs nothing in the container.

## Turn it on

1. Install Container Files from the Plugins tab.
2. Open the Container Files tab on a host that has SSH enabled.
3. Choose a container. It opens at the root folder.

Using the tab needs the Use Container Files permission, which admins and users get by default.

## Use it

- Double-click a folder to open it. Right-click for the actions: new file or folder, rename, copy, cut, paste, delete, permissions, symlink, compress, extract.
- Drag files from your computer into the window to upload. Use Download in the menu to save files or folders.
- Add more containers with the plus button. Panes tile the window; drag a pane by its header to move or swap it.
- The Mounts button lists the container's mounts (type, source, read-write or read-only). Mount folders carry an RW or RO letter in their icon.
- To add files to an archive, choose Add to archive in the menu or drop files on the archive (or on its open window). It works for zip, 7z, tar, tar.gz, tar.bz2, tar.xz and tar.zst and needs GNU tar, zip, 7z, gzip, bzip2, xz or zstd in the container to match; if it cannot, the reason is shown while you drag.
- To delete entries from an archive, select them in its open window and choose Delete (or press the Delete key), then confirm. It works for the same formats as adding and needs GNU tar for tar archives. rar archives can only be browsed and extracted, and single .gz, .bz2, .xz and .zst files can only be extracted. When a tool is missing the message names it, for example "7z is not installed in this container".
- Ctrl/Cmd+C, X and V copy, cut and paste between panes. Files copied in Windows Explorer or Finder paste with Ctrl/Cmd+V (files only, not folders).
- In dialogs, Enter presses the highlighted button, the arrow keys move between buttons and Escape closes the window.
- In Termix Desktop, the computer pane shows your own files. Drag between it and a container in either direction, or copy, cut and paste with the menu and Ctrl/Cmd+C, X and V (not between two local folders). On Windows, Copy in a container pane also puts the files on the Windows clipboard (up to 512 MB) so Explorer can paste them, and Ctrl+V pastes files and folders copied in Explorer into the container. Hosts set to connect via the server also work in the desktop app. The toolbar has a button to show the folder in your system file manager.
- Stopped and minimal containers (no shell) allow listing, reading, uploads and downloads only. Disabled actions say why.

Each user can set how many transfers run at once (1 to 4) in Settings.

## What it is allowed to do

| Capability                                     | Why                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `hosts:read`, `credentials:use`, `ssh:connect` | Connect to the host with its saved login and run `docker` or `podman` there. The plugin never sees the password or key. |
| `network:serve`                                | Its own routes for listing, transfers and progress.                                                                     |
| `ui:surface`                                   | The tab and the settings.                                                                                               |
| `desktop:local`                                | Termix Desktop only: show your computer's files and read or write the files you drag.                                   |

The plugin makes no network calls of its own and sends no telemetry. Local files are only touched when you act on them.

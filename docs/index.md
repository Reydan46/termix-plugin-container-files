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
- In Termix Desktop, the computer pane shows your own files. Drag between it and a container in either direction. The toolbar has a button to show the folder in your system file manager.
- Stopped and minimal containers (no shell) allow listing, reading, uploads and downloads only. Disabled actions say why.

Each user can set how many transfers run at once (1 to 4) in Settings.

## What it is allowed to do

| Capability | Why |
| --- | --- |
| `hosts:read`, `credentials:use`, `ssh:connect` | Connect to the host with its saved login and run `docker` or `podman` there. The plugin never sees the password or key. |
| `network:serve` | Its own routes for listing, transfers and progress. |
| `ui:surface` | The tab and the settings. |
| `desktop:local` | Termix Desktop only: show your computer's files and read or write the files you drag. |

The plugin makes no network calls of its own and sends no telemetry. Local files are only touched when you act on them.

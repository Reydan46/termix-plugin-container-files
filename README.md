# Container Files

**English** · [Русский](README.ru.md)

A [Termix](https://github.com/Termix-SSH/Termix) plugin that lets you browse and manage the files inside Docker and Podman containers, over the SSH connection you already use for the host. Nothing is installed in the container.

## What you can do

- Pick a host, see its containers, open one and work with its filesystem.
- Browse in list or grid view, with a folder tree, search, sorting and multi-select.
- Create, rename, copy, cut, paste, delete, change permissions and owner, make symlinks.
- Edit text files, preview images, audio, video, PDF and Markdown.
- Upload and download files and folders, with progress and cancel.
- Compress and extract archives, or browse inside an archive without extracting.
- Open several containers side by side in tiled panes and drag files between them.
- Termix Desktop: also open a pane with your own computer and drag files between it and a container.
- Open a terminal in the container.
- English and Russian.

## Install

Open Plugins in Termix, turn on the community registry (admins), find Container Files and install it. Then open the Container Files tab on a host with SSH enabled.

See the [docs](docs/index.md) for the details, including what the plugin is allowed to do and why.

## Limits

- The host user must be able to run `docker` or `podman`.
- Stopped and minimal (no shell) containers only allow listing, reading, uploading and downloading; actions that need a shell are disabled with a reason.
- Archives can be browsed and extracted, not modified.
- Transfers cannot be resumed.

## Development

```
npm install
npm test
npm run typecheck
npm run validate
npm run build
```

[Architecture](docs/architecture.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

The file manager UI is based on Termix Plugin-File-Manager (Apache-2.0). Licensed under Apache-2.0.

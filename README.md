# Container Files

**English** · [Русский](README.ru.md)

A [Termix](https://github.com/Termix-SSH/Termix) plugin that lets you browse and manage the files inside Docker and Podman containers, over the SSH connection you already use for the host. Nothing is installed in the container.

## What you can do

- Browse a container's filesystem in list or grid view, with a folder tree, search and multi-select.
- Manage files: create, rename, copy, move, delete, permissions, symlinks.
- Edit text files and preview images, audio, video, PDF and Markdown.
- Upload and download files and folders, with progress and cancel.
- Work with archives (zip, 7z, tar, rar and more): browse, extract, add files and delete entries without unpacking.
- See the container's mounts, with read-write and read-only ones marked.
- Open several containers side by side and drag or copy files between them, or from your own computer (Termix Desktop, Explorer and Finder).
- Open a terminal in the container.
- English and Russian.

## Install

Open Plugins in Termix, turn on the community registry (admins), find Container Files and install it. Then open the Container Files tab on a host with SSH enabled.

See the [docs](docs/index.md) for the details, including what the plugin is allowed to do and why.

## Limits

- The host user must be able to run `docker` or `podman`.
- Stopped and minimal (no shell) containers only allow listing, reading, uploading and downloading; actions that need a shell are disabled with a reason.
- Archives need their tool in the container (unzip or zip, 7z, tar, gzip, bzip2, xz, zstd, unrar). Rar and single compressed files are read-only, and changing tar archives needs GNU tar. When a tool is missing the reason is shown.
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

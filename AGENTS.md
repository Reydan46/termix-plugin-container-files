# AGENTS.md

This repo is a [Termix](https://github.com/Termix-SSH/Termix) plugin. These notes are for AI coding tools.

## Read first

Before changing anything, read `node_modules/@termix-ssh/plugin-sdk/PLUGIN-GUIDE.md`. It covers the
manifest, backend, database, frontend, UI, testing, releasing and submitting to the community registry,
and it matches the SDK version installed here. If it is missing, run `npm install`. If it is still missing,
the SDK is older than 1.0.6: run `npm install -D @termix-ssh/plugin-sdk@latest` or read
https://docs.termix.site/develop instead.

If the guide and the SDK's TypeScript types disagree, the types are right.

## Commands

```bash
npm run build        # bundle into dist/
npm test             # run the tests
npm run typecheck    # type check
npm run pack         # write <id>-<version>.tmxplug
npm run format       # format with Prettier
```

`npx termix-plugin dev --server <url> --key <tmx_...>` installs the plugin on a Termix server with
developer mode on and reinstalls it on every save. Don't start it unless the user asks.

## Done means

- `npm test`, `npm run typecheck`, `npm run validate`, `npm run build` and `npm run format:check` pass
- New UI text is in `locales/en.json`, new routes have an `@openapi` block and a test
- `docs/` and the section below still match what the plugin does
- User facing changes are in `CHANGELOG.md` under the version they ship in

## About this plugin

- What it does: a file manager for Docker and Podman container filesystems on an SSH host. It has a tiled workspace of panes, an editor, previews, archives, permissions, uploads and downloads, container to container copy, and on Desktop a local files pane.
- Backend (`src/backend/`): runs docker/podman over the host's SSH connection. Every command is built in `shell-quote.ts` with positional arguments; never put a path into a script string.
- Frontend (`src/frontend/`): the file manager UI in `src/frontend/vendor/file-manager/` is copied from Plugin-File-Manager (Apache-2.0). Keep those files byte-identical to upstream. Our differences are a shim layer in `vendor/file-manager/api/` and numbered patches in `vendor/patches/file-manager/`. Update with `node scripts/sync-upstream.mjs file-manager` (`--check` only reports).
- Locales: edit `locales-src/*.json`, then run `node scripts/build-locales.mjs`, which writes `locales/`.
- More: `docs/architecture.md`, `docs/orchestrator-parity.md`.

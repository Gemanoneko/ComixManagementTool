# ComixManagementTool — Brief

## What It Does
Electron desktop app (Windows) that converts comic archive files (`.cbr`, `.rar`, `.zip`, `.pdf`) into `.cbz` format. Recursively scans folders, handles split archives, validates every output, and optionally deletes originals only after successful validation.

## What Sergei Does With It
Point it at a folder of downloaded comics/manga, click Convert, walk away. Originals are safely deleted only when replacement `.cbz` files have passed validation.

## What It Explicitly Does Not Do
- No online content fetching, no scraping, no library management
- No reading UI — this is a file-conversion tool, not a comic reader
- No cross-platform builds — Windows only

## Tech Stack
- Electron (vanilla HTML/CSS/JS renderer, no framework)
- Bundled 7-Zip (`vendor/7zip/`) for extraction, packing (`a -tzip -mx=0`), and validation (`t` + `l -slt`)
- Runtime-detected ImageMagick for PDF → PNG at 300 DPI
- `electron-builder` for NSIS installers, `electron-updater` for auto-update
- GitHub Actions CI builds + releases — the only release path (see Decision Log)

See [CLAUDE.md](../CLAUDE.md) for full architecture and conventions.

## Commands
| Purpose | Command |
|---|---|
| Fresh install on a new machine | `npm ci` |
| Run in dev | `npm start` (plain `electron .` — no dev server) |
| Local installer, never publishes (packaged QA) | `npm run prepare-vendor && npm run pack` → `dist\ComixManagementTool Setup <version>.exe` |
| Release (canonical) | bump + commit, then push the named tag `v<version>` → `.github/workflows/build.yml` builds and publishes |

`npm run release` and `npm run build` both refuse to run on a laptop — see Decision Log.

## Repo
- GitHub: `https://github.com/Gemanoneko/ComixManagementTool`
- Local: `WIP/ComixManagementTool/`

## Current Version
See `package.json` (`version` field is the source of truth).

## Stage
**Daily Use / Maintain** — tool is past prototype, actively used, has a working CI release pipeline with `keep-last-4` cleanup.

## Decision Log
*Consequential choices only (ProcessRules § Decision Log in every tool Brief).*

| Decision | Chosen | Alternatives (why not) | Revisit when |
|---|---|---|---|
| Release path (2026-09-28) | **CI only.** A named-tag push runs `.github/workflows/build.yml`, which builds and publishes. On a laptop, `scripts/release.mjs` refuses and points at the tag push, and `npm run build` goes through `scripts/ci-publish-guard.mjs`, which refuses unless it's running inside GitHub Actions. | Removing the `release` script — rejected: a bare "missing script" error explains nothing, and `npm run build` would still publish from any machine with `GH_TOKEN` set. Keeping both paths live — rejected: a laptop publish collides with CI's run for the same tag (ProcessRules § Release paths are per tool). | CI becomes unavailable, or the tool moves to local releases like QuickLaunch. |
| Release cleanup (2026-09-28) | `scripts/cleanup-releases.js` runs as a **separate final CI step** with `continue-on-error: true`, only after the publish succeeded; the build+publish step stays strict. | Chained through `postbuild` inside the build step (the old wiring — a cleanup hiccup failed a release that had already published). | The workflow gains more post-publish steps. |
| Window close (2026-09-28) | `window-all-closed` → `app.quit()` unconditionally — no macOS exception; the tool is Windows-only (ProcessRules § The close button must always quit the process). | Keeping the `darwin` guard — dead code on Windows that the studio rule forbids. | The tool ever targets macOS. |

## Notes
- External dependencies (7-Zip installer, ImageMagick) are NOT bundled — hardcoded paths in `src/converter.js`; runtime-detected. Document this clearly in any install instructions.
- Letter Jam-style level JSON sensitivity does not apply here — this tool has no external consumers.

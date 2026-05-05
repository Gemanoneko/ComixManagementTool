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
- GitHub Actions CI builds + releases

See [CLAUDE.md](../CLAUDE.md) for full architecture and conventions.

## Repo
- GitHub: `https://github.com/Gemanoneko/ComixManagementTool`
- Local: `WIP/ComixManagementTool/`

## Current Version
See `package.json` (`version` field is the source of truth).

## Stage
**Daily Use / Maintain** — tool is past prototype, actively used, has a working CI release pipeline with `keep-last-4` cleanup.

## Notes
- External dependencies (7-Zip installer, ImageMagick) are NOT bundled — hardcoded paths in `src/converter.js`; runtime-detected. Document this clearly in any install instructions.
- Letter Jam-style level JSON sensitivity does not apply here — this tool has no external consumers.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ComixManagementTool is an Electron desktop app for Windows that converts comic archives
(`.cbr`, `.rar`, `.zip`, `.pdf`) into `.cbz` format, with recursive folder scanning,
split-archive support, validation, and optional deletion of originals.

## Setup & Running

```bash
npm install          # installs electron + adm-zip + electron-builder
npm start            # launches the Electron app (dev mode)
```

## Building

```bash
npm run prepare-vendor   # copies 7z.exe + 7z.dll from C:\Program Files\7-Zip into vendor/7zip/
npm run dist             # local portable build (dir target + icon stamp) → dist/win-unpacked/
npm run pack             # local NSIS installer (no publish) → dist/
npm run build            # CI: NSIS installer + publish to GitHub Releases
```

**What gets bundled:** adm-zip (JS), electron-updater, 7-Zip (`vendor/7zip/`).
**Not bundled:** ImageMagick — the app auto-detects it at runtime from `C:\Program Files\ImageMagick*\magick.exe` or PATH. PDF conversion will fail gracefully if ImageMagick is missing.

## Releasing

1. Bump version in `package.json`, commit with `v{version}: description`
2. Tag and push: `git tag v{version} && git push && git push origin v{version}`
3. GitHub Actions (`.github/workflows/build.yml`) builds the NSIS installer and creates a GitHub Release
4. Post-build `scripts/cleanup-releases.js` auto-deletes old releases (keeps 4)
5. Installed apps auto-check for updates 5s after launch via `electron-updater`

## External Dependencies (must be installed separately)

| Tool | Path | Used for |
|------|------|----------|
| 7-Zip | `C:\Program Files\7-Zip\7z.exe` | Extracting `.cbr`/`.rar`/`.zip` |
| ImageMagick 7 | `C:\Program Files\ImageMagick-7.1.2-Q16-HDRI\magick.exe` | PDF → PNG at 300 DPI |

Paths are hardcoded in [src/converter.js](src/converter.js) (`SEVEN_ZIP`, `IMAGEMAGICK`).

## Architecture

```
main.js          Electron main process — window creation, IPC handlers
preload.js       Context-bridge: exposes { invoke, on, removeAllListeners } to renderer
renderer/        UI (vanilla HTML/CSS/JS, no framework)
  index.html     Layout: folder panel, action bar, log panel, delete-modal
  styles.css     Dark theme
  app.js         All renderer logic — folder selection, IPC calls, log rendering
src/
  scanner.js     Recursive walk; returns paths of .cbr/.rar/.zip/.pdf files
  converter.js   Core pipeline: extract → analyse → pack → validate; calls scanner/renamer/validator
  validator.js   Opens CBZ with adm-zip, checks image count + magic bytes
  renamer.js     Decides output filename; only renames if current name is generic
```

### Conversion pipeline (converter.js)

1. **Extract** — 7-Zip for archives; `magick -density 300` for PDFs
2. **Analyse structure** (`buildGroups`)
   - No subdirs → single CBZ named after the archive
   - Single subdir whose name ≈ archive name → wrapper folder, treated as flat
   - Multiple subdirs → one CBZ per subdir + one for any loose images at root
3. **Pack** — `adm-zip` creates a flat ZIP (no internal folders) named by `buildOutputName`
4. **Validate** — image count match + magic-byte check on every entry
5. Original is added to the "delete candidates" list only if ALL outputs validated

### Naming rules (renamer.js)

- **Generic names** (`chapter_5`, `vol_02`, `001`, `ch 12`, …) are renamed using context.
- **Clear names** (`Batman - Volume 3 - #45`) are left untouched.
- Split subdirs always get their parent archive name prepended.

Comics pattern: `Series Name - Volume X - #Issue`
Manga pattern:  `Series Title - Vol XX - Ch YYY`

### IPC channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `dialog:openFolder` | renderer → main | Open folder picker |
| `conversion:start` | renderer → main | Begin conversion with `{ rootFolder, isManga }` |
| `conversion:cancel` | renderer → main | Abort via `AbortController` |
| `conversion:deleteOriginals` | renderer → main | Delete file list, returns `{ file, success }[]` |
| `conversion:log` | main → renderer | `{ msg, type }` — types: info/success/warn/error/skip/header |
| `conversion:progress` | main → renderer | `{ current, total }` |
| `conversion:complete` | main → renderer | `{ originals: string[], aborted?: boolean }` |

## Versioning

Bump `version` in `package.json` automatically after every code change, before committing:

- **Patch** `x.x.+1` — bug fixes, small UI tweaks, copy changes
- **Minor** `x.+1.0` — new features, meaningful UX additions, new IPC flows
- **Major** `+1.0.0` — breaking changes or complete overhauls (confirm with user first)

## Key Conventions

- Use `-LiteralPath` (PowerShell) / literal file paths everywhere — filenames contain `[`, `]`, spaces.
- `adm-zip` is used for **packing and validation only**; 7-Zip handles all extraction.
- CBZ images are stored **flat** (no internal folder hierarchy) — this is the CBZ standard.
- Natural sort (`localeCompare` with `numeric: true`) is applied to image filenames before packing so pages read in order.
- Never delete or overwrite an original until its CBZ has passed validation.
- PDF pages output as `basename_0000.png … basename_NNNN.png` at 300 DPI, lossless PNG.

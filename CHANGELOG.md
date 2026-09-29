# Changelog

All notable changes to this tool are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project uses date-stamped
version tags rather than semantic versioning strictness.

## [v1.10.0] - 2026-09-29

### Added
- Folder-pack fix flow: after a run, folders that failed on bad names can be renamed (Remove or Replace with `_`, Fix All with a confirm) and retried; a folder packs automatically once its last bad name is fixed.
- Grouped end-of-run error blocks for Convert and Resize, matching folder-pack.
- Folder-pack leaves `Thumbs.db` and `desktop.ini` out of CBZs without counting them as missing.

### Changed
- Folder-pack packs every file into the CBZ and validates against the source folder; one failure never stops the run.
- Convert validates existing outputs before treating them as done; only one app copy runs at a time.

### Fixed
- Data-loss guards: no original is offered for deletion without its own pages validated; a CBZ containing other pages fails the file and leaves nothing behind.
- Deep archives convert and resize; resize keeps non-page entries and exact names; unwrap and re-runs use the `_` rule.
- Folder names ending in a space or period, and device-name outputs, are handled.
- Very long paths no longer crash folder-pack; cancelling folder-pack reports "Conversion cancelled."; leftover `.resize.tmp` files are swept at startup.

## [v1.9.7] - 2026-09-28

### Changed
- Closing the last window now goes through one unconditional quit — the macOS-only branch is
  gone; no behavior change on Windows.
- Release cleanup now runs as its own final CI step, so a cleanup error can no longer fail a
  release that already published.
- Publishing is CI-only: `npm run release` and `npm run build` refuse to run outside GitHub
  Actions, and `npm run pack` builds a local installer that never publishes.

## [v1.9.6] - 2026-05-05

### Fixed
- 7-Zip: `@listfile` now emitted as a positional argument, dropping `--` when present.

## [v1.9.5] - 2026-04-24

### Changed
- Full cleanup sweep: Majors M2–M5, Minors, and re-review micro-fixes.
- `.gitignore` now excludes electron-builder cache binaries and `comic.png`.

## [v1.9.4] - 2026-04-24

### Fixed
- Abort-mid-pack data-loss window closed (Senua M1).

## [v1.9.3] - 2026-04-24

### Changed
- `release.mjs` now sources `GH_TOKEN` from the `gh` CLI.

## Earlier releases

Releases before v1.9.3 (back through v1.0.0) are recorded only in git tag history —
see `git log --oneline --decorate --tags` in this repo.

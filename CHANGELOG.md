# Changelog

All notable changes to this tool are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project uses date-stamped
version tags rather than semantic versioning strictness.

## [v1.9.7] - 2026-09-28

### Fixed
- Closing the last window now always quits the app — the leftover macOS-only branch is gone.

### Changed
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

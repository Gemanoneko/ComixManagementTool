#!/usr/bin/env node
// `npm run release` is intentionally disabled for ComixManagementTool.
//
// The canonical (and only) release path is GitHub Actions: pushing a named
// v<x.y.z> tag runs .github/workflows/build.yml, which builds the NSIS
// installer, publishes the GitHub Release, then prunes to the newest 4.
//
// This script used to source GH_TOKEN from `gh auth token` and run
// `npm run build` (electron-builder --publish always) from the laptop — a
// second publish path that could collide with CI publishing the same version
// (two different builds uploading to one release). It now refuses before
// touching any credential and points at the tag-push path. The old gh-token
// bridge is in git history (added in v1.9.3, commit a518030) should CMT ever
// move to local releases; the studio's working template lives in QuickLaunch.

const lines = [
  'Refusing: ComixManagementTool is never published from this machine.',
  'Releases are built and published by GitHub Actions on a named-tag push:',
  '  1. Version bump (package.json + package-lock.json) committed and pushed',
  '  2. git tag v<x.y.z> && git push origin v<x.y.z>   (named tag only - never --tags)',
  '  CI (.github/workflows/build.yml) then builds the installer, publishes the',
  '  GitHub Release, and prunes old releases to the newest 4.',
  'Need an installer without publishing (e.g. QA smoke test)?  npm run pack  ->  dist/',
];
for (const line of lines) console.error(`[release] ${line}`);
process.exit(1);

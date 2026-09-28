#!/usr/bin/env node
// CI-only guard for `npm run build` (which runs `electron-builder --publish always`).
//
// ComixManagementTool publishes ONLY from GitHub Actions: a named v<x.y.z> tag
// push runs .github/workflows/build.yml, which calls `npm run build`. Anywhere
// else this exits 1 before electron-builder starts, so `npm run build` on a
// laptop can never publish a release by accident, even if GH_TOKEN happens to
// be set there. GitHub Actions sets GITHUB_ACTIONS=true for every step.
//
// Chained in package.json with `&&` rather than a `prebuild` hook on purpose:
// npm skips pre/post hooks under --ignore-scripts, which would bypass a hook.

if (process.env.GITHUB_ACTIONS === 'true') {
  console.log('[build] GitHub Actions detected - continuing to electron-builder --publish always.');
  process.exit(0);
}

console.error('[build] Refusing: `npm run build` publishes a GitHub Release and only runs in GitHub Actions.');
console.error('[build] To release: push a named tag (git push origin v<x.y.z>, never --tags) - CI builds and publishes.');
console.error('[build] For a local installer that is never published (e.g. QA): npm run pack');
process.exit(1);

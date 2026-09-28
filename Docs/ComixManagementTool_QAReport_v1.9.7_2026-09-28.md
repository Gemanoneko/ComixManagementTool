# ComixManagementTool — QA Report v1.9.7 — 2026-09-28

**Tester:** Futaba (QA / Dogfooder)
**Scope:** Behavior half of dual clearance for v1.9.7 (Senua covers construction in parallel). Release commit `82f6f0e` on `main`, pushed, not yet tagged.

## Entry-gate receipt (qa-handoff skill)

```
Entry-check receipt: comix-management-tool v1.9.7 @ 82f6f0e (dirty: N) — pre-qa n/a, post-build n/a, check-electron n/a, check n/a, test:smoke n/a
```

No declared check scripts in this tool's `package.json` (`pre-qa`/`post-build`/`check-electron`/`check`/`test:smoke` are all absent), so all five read n/a — expected, this tool has never declared scripted checks. HEAD hash and dirty flag match the release commit named in the brief.

## What changed since v1.9.6 (read for context)

Per `git log fdfdbb0 82f6f0e` and `CHANGELOG.md`: (1) `main.js` `window-all-closed` quits unconditionally, removing a leftover macOS-only branch; (2) release cleanup (`cleanup-releases.js`) is now its own final CI step with `continue-on-error`; (3) `npm run release` / `npm run build` refuse outside GitHub Actions, `npm run pack` never publishes; (4) lockfile + changelog bump; (5) `.claude/settings.json` deny-list mirror. No user-facing behavior other than (1) is meant to change.

## Build (local, non-publishing)

All commands run from `WIP/ComixManagementTool` on this machine, `GITHUB_ACTIONS` unset throughout.

| Command | Timeout used | Result | Wall time |
|---|---|---|---|
| `npm ci` | 600000ms | exit 0 — 319 packages installed | 9.5s |
| `npm run prepare-vendor && npm run pack` | 600000ms | exit 0 | 20.6s |

`npm ci` printed `npm warn install-scripts 1 package has install scripts not yet covered by allowScripts: electron@29.4.6 (postinstall: node install.js)` and, as a result, `node_modules/electron/dist` has no local Electron binary / `path.txt` — this machine's npm config blocks install scripts by default. This is a pre-existing machine-level npm policy, not something this release changed, and it didn't block the packaged build: `electron-builder` fetches and caches its own Electron binary independently (log shows `downloading … electron-v29.4.6-win32-x64.zip … downloaded … duration=4.561s`), so `npm run pack` succeeded regardless. Flagging it because it does mean **`npm start` (dev mode) would fail on this machine** as-is — untested here since it's out of scope, but worth Ender/Sergei knowing if dev mode is exercised on this box later.

Build produced both expected artifacts:
- `dist\ComixManagementTool Setup 1.9.7.exe` (78,190,548 bytes)
- `dist\win-unpacked\ComixManagementTool.exe` (176,598,528 bytes)

`git status --porcelain` after the build: empty (clean). `dist/` is gitignored, confirmed via `git check-ignore -v dist`.

## Publish-guard check

Run after the build, `GITHUB_ACTIONS` unset:

```
$ npm run build
[build] Refusing: `npm run build` publishes a GitHub Release and only runs in GitHub Actions.
[build] To release: push a named tag (git push origin v<x.y.z>, never --tags) - CI builds and publishes.
[build] For a local installer that is never published (e.g. QA): npm run pack
EXIT: 1

$ npm run release
[release] Refusing: ComixManagementTool is never published from this machine.
...
EXIT: 1
```

Both refused with exit 1 and a clear message before electron-builder ran (no `packaging`/`downloading` lines in either output, confirming `ci-publish-guard.mjs` / `release.mjs` short-circuit before touching electron-builder).

## Packaged-app testing

Tested `dist\win-unpacked\ComixManagementTool.exe` — the packaged bundle, **not** the NSIS installer (never run, per instructions, to avoid touching Sergei's installed copy) and **not** the dev build.

**Pre-launch safety check:** `tasklist /FI "IMAGENAME eq ComixManagementTool.exe"` showed nothing running before any test launch — Sergei's copy was not up, so testing proceeded.

**Profile isolation:** `main.js` has no `app.setPath('userData', …)` override, so the standard Electron `--user-data-dir` switch applies cleanly. Launched with `--user-data-dir=<scratchpad>\cmt-profile`. Verified:
- The throwaway profile directory populated with a full fresh userData structure (Cache, Local Storage, Preferences, etc.) immediately after first launch — proves the switch took effect.
- `find` on both real profile candidates (`%APPDATA%\comix-management-tool` — the one with real usage data, last touched 2026-09-25 — and `%APPDATA%\ComixManagementTool`, a near-empty legacy folder) for anything newer than a pre-launch snapshot returned nothing, before and after all three launch/close cycles. Real user data was never touched.

**(a) Version check** — read directly from the packaged bundle via `@electron/asar` (vendored under `node_modules/app-builder-lib`) against `dist\win-unpacked\resources\app.asar`:
```
version from asar package.json: 1.9.7
name: comix-management-tool
main: main.js
```
Confirms the shipped bundle is 1.9.7. Did **not** additionally confirm an in-app version label — the app has no visible chrome/about panel reachable without clicking through the UI, which is out of reach non-interactively; noting as not exercised rather than implying coverage.

**(b) Close behavior** — graceful close via `taskkill /PID <main-pid>` with **no** `/F`, simulating the window's (x) button, repeated 3 times against fresh launches:

| Round | Main PID | Helper PIDs also running | taskkill result | Full exit confirmed |
|---|---|---|---|---|
| 1 | 92668 | 154840, 201776, 220076 | `SUCCESS: Sent termination signal...` | All 4 gone within 1s (checked at 1s and 3s) |
| 2 | 222380 | 195588, 178428, 221568 | `SUCCESS: Sent termination signal...` | All 4 gone within 1s |
| 3 | 208044 | 211780, 186644, 207936 | `SUCCESS: Sent termination signal...` | All 4 gone within 1s |

All three rounds: clean, full-process exit with no ghost helper processes left in `tasklist`, consistent with the `main.js:97` fix (`app.on('window-all-closed', () => app.quit())`, unconditional, no macOS branch) and the `before-quit` handler that aborts in-flight child processes/controllers. This is the exact behavior the release commit claims to fix, and it held on 3/3 tries.

**(c) Other observations, no dialogs clicked through:**
- Round 3's console output showed the app's own update check firing (`Checking for update` / `Update for version 1.9.7 is not available (latest version: 1.9.6, downgrade is disallowed)`) — expected: this build isn't tagged/published yet, so GitHub Releases still reports 1.9.6 as latest. Not a defect; confirms `electron-updater` correctly refuses a "downgrade" against an unpublished local build rather than misbehaving.
- Not exercised: the actual conversion pipeline (folder picker, CBZ conversion, delete-originals modal) — all of these need native file-dialog clicks that can't be driven non-interactively, and were out of scope for this behavior-only, no-user-facing-change release. No functional regression risk was flagged for this area in the diff, so this is a coverage gap to note, not a suspected break.

## Cleanup

Final sweep after round 3: `tasklist` for `ComixManagementTool.exe` and `electron.exe` both empty — no stray processes. Real `%APPDATA%` profile folders confirmed unchanged (no files newer than the pre-test snapshot). Tool repo `git status --porcelain` empty. No windows left open, no focus stolen beyond the launches themselves.

## Findings

None — Blocker, Major, or Minor. The one thing worth a name is not a bug in this release: this machine's npm `allowScripts` policy silently skips Electron's postinstall, which would break `npm start` (untested, out of scope) but did not affect `npm run pack`, which is what actually ships. Filing as an environment note, not a severity-tagged finding, since it predates this release and doesn't affect the packaged artifact under test.

Pattern alerts: none

## Not exercised (explicit)

- NSIS installer itself (`ComixManagementTool Setup 1.9.7.exe`) — by design, to avoid touching Sergei's installed copy.
- In-app version label / about panel, if one exists — needs a GUI click to reach.
- Core conversion flow (folder pick → convert → validate → delete-originals) — needs native dialog interaction; also unrelated to this release's diff.
- `npm start` dev-mode launch — blocked by this machine's npm install-script policy, unrelated to the release diff.

**Verdict:** GO

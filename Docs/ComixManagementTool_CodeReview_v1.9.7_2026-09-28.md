# Code Review — ComixManagementTool v1.9.7

## Header

```
Reviewer: Senua (Code Reviewer)
Date: 2026-09-28
Tool: ComixManagementTool
Release: v1.9.7
Commit range: v1.9.6 (de19e68)..82f6f0e  — fdfdbb0, 82f6f0e
Files changed: 11 files, +175 / -64
Stand-down dimensions: 4 Performance, 6 Input Handling (N/A, reasons inline)
```

---

## Summary

Two commits. `fdfdbb0` copies the studio-baseline deny list into the repo's `.claude/settings.json`. `82f6f0e` is the v1.9.7 milestone. It drops the `darwin` guard from `window-all-closed`. It moves `cleanup-releases.js` out of `postbuild` into its own final CI step with `continue-on-error: true`. It adds `scripts/ci-publish-guard.mjs` in front of `npm run build`, turns `scripts/release.mjs` into an unconditional refusal, bumps the version to 1.9.7 (lockfile included), and updates CLAUDE.md, the Brief and a new CHANGELOG.

What I checked:
- **Workflow YAML.** Parsed with the repo's own `node_modules/js-yaml`. It has the intended shape: `continue-on-error` is a real boolean, it sits on the cleanup step only, and no step has an `if:`, so cleanup gets the default `success()`.
- **Guard and release scripts.** I ran both directly; neither builds anything. The guard exits 1 with `GITHUB_ACTIONS` unset, exits 1 with it set to `True`, and exits 0 with it set to `true`. `release.mjs` exits 1.
- **Syntax.** `node --check` passes on all changed JS.
- **GitHub state (read-only).** No v1.9.7 release exists yet. The remote has 4 releases and 4 tags (v1.9.3–v1.9.6). The last CI run was v1.9.6 on 2026-05-05, and every step succeeded.
- **electron-builder 24.13.3.** I read its installed publish logic to answer "can it go green while publishing nothing?". The answer is yes; see F1.

Nothing in this range meets the Critical bar, and the safety floor is intact. There are three Majors, and all three harden the pipeline for future releases. None of them breaks this tag's first run.

**Coverage gap (scope note, not a finding).** The last code-review report on file is `ComixManagementTool_CodeReview_2026-04-24.md`, at v1.9.2, HEAD `97a1a64`. The skill's range rule ("since the last review") would therefore start this review at `97a1a64`, not `v1.9.6`. The 7 commits in `97a1a64..v1.9.6` (v1.9.3–v1.9.6) are about 626 inserted lines, and no report on file covers them. They include new `src/seven-zip.js` and `src/exec.js` plus the v1.9.6 7-Zip argument-shape change, which is the command-injection focus area. v1.9.5's subject mentions "re-review micros", but no report records it. This report certifies only `v1.9.6..82f6f0e` as briefed. Jane decides whether a catch-up review of `97a1a64..v1.9.6` is needed.

---

## Rubric

### 1. Security

- Status: Concerns
- Findings:
  - **F3** `.claude/settings.json:55-86` (and allow rules at `:28`, `:31`, `:46`) — [Major] — The deny list copies the studio baseline faithfully, but it inherits gaps in exactly the safety-floor areas it is meant to guard:
    - **`--tags`.** Nothing denies `git push --tags`, even though "never `--tags`" is a CLAUDE.md headline rule. This machine already holds v1.9.0–v1.9.2 as local tags that the remote has pruned, which is the precondition for the Monday resurrect-old-tags incident (ProcessRules § Named-tag pushes).
    - **Force-push forms that slip past.** `-f` after the operands (`git push origin main -f`), a `+refspec` (`git push origin +main`) and `--mirror` all get past the `git push -f*` / `*--force*` patterns.
    - **Direct publish.** With `Bash(*)` and `Bash(npx:*)` allowed, `npx electron-builder --publish always` runs without a prompt and bypasses the guard. It fails only because `GH_TOKEN` is normally unset.

    None of this is a regression in this diff. Fix it in the studio baseline and copy it here again.
  - **F12** `.github/workflows/build.yml:17-18` — [Minor, pre-existing lines] — `actions/checkout@v4` keeps its default `persist-credentials: true`. That writes the `contents: write` GITHUB_TOKEN into `.git/config`, where every dependency lifecycle script run by `npm ci` can read it. Nothing later in the job needs git auth, so set `persist-credentials: false`.
  - Positives: `release.mjs` no longer reads the PAT at all, and its `spawnSync(..., { shell: true })` is gone. No token is logged anywhere. The Electron webPreferences are unchanged: `contextIsolation: true`, `nodeIntegration: false`. `scripts/` is not in the packaged `files` whitelist.

### 2. Correctness & Logic

- Status: Concerns
- Findings:
  - **F1** `.github/workflows/build.yml:36-50` and `scripts/ci-publish-guard.mjs:13-16` — [Major] — The run can finish green having published nothing. When a non-draft release for `v<package.json version>` already exists and was published more than 2 hours earlier, electron-builder logs a warning ("GitHub release not created" / "skipped publishing") and exits 0 (`node_modules/electron-publish/out/gitHubPublisher.js:85-93, 124-127`). It also derives the release tag from `package.json`, not from the pushed tag. So a tag pushed on a commit whose version wasn't bumped (for example `v1.9.8` on a 1.9.7 commit, after 1.9.7 has been out for 2 hours) produces a green run. The cleanup step then prunes against it.

    Nothing asserts that `GITHUB_REF_NAME === 'v' + version`, or that the release has its `.exe`, `.blockmap` and `latest.yml` before the prune runs. Fix: have the guard also require `GITHUB_REF_TYPE === 'tag'` and a tag/version match, and add a strict `gh release view "$GITHUB_REF_NAME" --json assets` check step between publish and cleanup.

    Not Critical for this tag: `package.json` is 1.9.7 at 82f6f0e and no v1.9.7 release exists. Sully's artifact-version check is the current backstop, so keep it.
  - Guard behaviour verified: it matches the exact string `true` (case-sensitive), which GitHub always sets for every step. The `&&` chain is valid under npm's cmd.exe script shell, and a non-zero exit carries through pwsh's `exit $LASTEXITCODE` wrapper. The comment's claim about `--ignore-scripts` is correct (npm still runs the named script but skips pre/post hooks). No laptop path in `package.json` reaches `--publish always` without the guard: `pack` and `dist` are `--publish never`, and `release.mjs` spawns nothing.

### 3. Crash / Stability Safety

- Status: Pass — `main.js:97` complies with ProcessRules § The close button must always quit the process. It behaves the same as before on win32. `before-quit` (`main.js:102-113`) is unchanged. Grep confirms there are no `close` interceptors, no `beforeunload` handlers and no `will-quit` hooks in main, renderer or updater.

### 4. Performance

- Status: N/A — No runtime code path in the range has a performance dimension. The only runtime change is a one-line quit handler.

### 5. State & Data Safety

- Status: Pass (one Minor)
- Findings:
  - The prune runs only after a strict publish succeeds, because the default `success()` applies. Deleting the old release and its remote tag is sanctioned by ProcessRules § Keep only the 4 most recent GitHub releases. Commits stay on `main`, so this is not a source-of-truth loss.
  - **F11** `scripts/cleanup-releases.js:58` — [Minor, pre-existing, newly invoked from the workflow] — The prune sorts by the release's `created_at`. The API documents that field as the tagged commit's date, and I checked it for v1.9.3–v1.9.6: `created_at` equals the commit timestamp exactly. The sort is correct for linear tagging, but if an older commit were ever tagged later, it would sort as "old" and be pruned first.

### 6. Input Handling

- Status: N/A — The range adds no user or IPC input. The guard reads one environment variable and exact-matches it.

### 7. Maintainability (no Critical findings on its own)

- Status: Pass — `release.mjs` gives a clear reason for its refusal and points to the old token bridge in history (`a518030`). The guard's header explains why it uses `&&` and not a `prebuild` hook.

### 8. Doc/Code Drift (no Critical findings on its own)

- Status: Concerns
- Findings:
  - **F4** `CHANGELOG.md:10` and the `82f6f0e` commit message — [Minor] — Both present the `darwin` removal as a fix: under "Fixed" in the changelog, and as "could leave the process alive after the last window closed" in the commit. On win32, `process.platform !== 'darwin'` was already true, so the old handler already quit. The change is a behaviour-neutral cleanup, and the Brief's Decision Log already calls it "dead code on Windows". Move the entry to "Changed" so it can never be cited as closing a ghost-process report.
  - **F5** `CHANGELOG.md:15` and the commit message — [Minor] — They say `npm run release` refuses "outside GitHub Actions", and the commit message credits the guard with that. In fact `release.mjs` refuses unconditionally, inside CI too, and doesn't use the guard.
  - **F6** `CHANGELOG.md:4-5` — [Minor] — The changelog says the project "uses date-stamped version tags". The tags are semver-shaped `vX.Y.Z`, and nothing is date-stamped.
  - **F7** `CHANGELOG.md:39-42` — [Minor] — It says releases before v1.9.3 are "recorded only in git tag history" and points to `git log --tags`. That is false:
    - The remote has no tag older than v1.9.3, because the prune deletes release and tag per policy (remote and local).
    - This machine has only v1.9.0–v1.9.2 locally.
    - v1.0–v1.8 were never tagged.

    That history actually lives in the 22 `v1.x.y:` commit subjects (`git log --oneline`). After this release's prune, the v1.9.3 tag goes too.
  - **F8** `CLAUDE.md:14, 36, 85, 121` — [Minor, lines unchanged but sitting in sections this commit rewrote] — These lines still say adm-zip is installed, bundled and used for packing and validation. `package.json` has no adm-zip dependency and nothing under `src/` imports it. The v1.9.6 Brief already says packing is 7-Zip `a -tzip -mx=0`.
  - **F10** `CLAUDE.md:46` and the `build.yml:42-43` comment — [Minor] — "A cleanup failure is flagged on the run" overstates it. With `continue-on-error`, the job and the run both finish green, and the failure shows only as a step annotation. Sully's keep-last-4 verify is the real catch.

### 9. Build & Release Hygiene

- Status: Concerns
- Findings:
  - **F2** `.gitignore:37` — [Major] — The entry is `scratch/ # local scratch dir — see …`. `.gitignore` has no inline comments, so the whole line is taken as one literal pattern and `scratch/` is **not** ignored (`git check-ignore -v scratch/foo.txt` exits 1). ProcessRules § Repository Hygiene says each tool's `.gitignore` carries this entry, and DelegationPrimer item 2 tells agents the folder is gitignored. So any probe written there shows up as untracked: it dirties the tree for `studio-status` and the release clean-tree check, and it can be committed. Fix: put the comment on its own line above a bare `scratch/`. The same line may also be in QuickLaunch or the studio's template (not checked, out of scope).
  - **F9** `.github/workflows/build.yml:23` — [Minor, pre-existing lines] — The workflow pins Node `20`, which reached upstream end-of-life on 2026-04-30, and uses `actions/*@v4`. CI last ran on 2026-05-05, so this tag is the first run on a `windows-latest` image about five months newer. I can't verify that locally. If it breaks, it breaks loudly: the strict build step goes red, nothing is published, cleanup is skipped, and `prepare-vendor` exits 1 if 7-Zip is missing.
  - Verified clean:
    - The version is bumped from 1.9.6 to 1.9.7.
    - The `package-lock.json` diff is exactly the two `"version"` fields (+2/−2, root and self-entry).
    - The build and prepare-vendor steps have no `continue-on-error`, and no `actions/upload-artifact` step exists (ProcessRules § CI storage rails).
    - The workflow and job token scope is `contents: write` only, which the release write and the ref delete both need.
    - `ci-publish-guard.mjs` is tracked, so CI will find it.

---

## Out-of-range observation (ungraded — not part of this verdict)

`main.js:411-429` (`resize:confirm`, last changed in v1.2.5) — The resizer writes its temp CBZ to `os.tmpdir()` (`src/resizer.js:311`), so `rename` fails with EXDEV whenever the library is on another drive. The fallback then runs `copyFile(tmp, original)`, which overwrites the original in place. If the app quits, crashes or loses power mid-copy, the original is left truncated. On the next launch, `cleanupOrphanedTempDirs` (`main.js:19-28`) sweeps the `cbz_resized_*` temp file, and both copies are gone. This is a data-loss window that predates this range and that no review on file mentions. It belongs in the next review or with Ender: copy to a sibling temp file on the destination volume, then rename.

---

## Verdict

- Total Critical: 0
- Total Major: 3 (F1, F2, F3)
- Total Minor: 9 (F4–F12)

**Verdict:** RELEASE CLEAR

| # | Sev | Dim | file:line | Finding | Next cycle |
|---|-----|-----|-----------|---------|------------|
| F1 | Major | 2 Correctness | `.github/workflows/build.yml:36-50`, `scripts/ci-publish-guard.mjs:13-16` | Run can go green having published nothing (electron-builder's silent skip; no tag/version or asset check) | Guard asserts ref is a tag equal to `v`+version; strict release-assets check before prune |
| F2 | Major | 9 Build hygiene | `.gitignore:37` | Inline comment makes the `scratch/` pattern literal, so `scratch/` is not ignored | Comment on its own line, bare `scratch/` |
| F3 | Major | 1 Security | `.claude/settings.json:55-86` | Inherited baseline gaps: no `git push --tags` deny; `-f`-after-operands, `+refspec`, `--mirror` slip past; `npx electron-builder --publish always` unprompted | Fix studio baseline, copy it here again |
| F4 | Minor | 8 Drift | `CHANGELOG.md:10` | darwin removal listed as "Fixed"; no-op on win32 | Move to "Changed" |
| F5 | Minor | 8 Drift | `CHANGELOG.md:15` | `npm run release` refuses everywhere, not only outside Actions | Reword |
| F6 | Minor | 8 Drift | `CHANGELOG.md:4-5` | "date-stamped version tags" is wrong | Reword |
| F7 | Minor | 8 Drift | `CHANGELOG.md:39-42` | Pre-v1.9.3 history points at tags that are pruned or never existed | Point at `git log --oneline` |
| F8 | Minor | 8 Drift | `CLAUDE.md:14,36,85,121` | adm-zip described as installed, bundled and used; it is not | Update to 7-Zip packing |
| F9 | Minor | 9 Build hygiene | `.github/workflows/build.yml:23` | Node 20 past EOL; first CI run in about 5 months | Bump Node / actions on next CI touch |
| F10 | Minor | 8 Drift | `CLAUDE.md:46` | "Flagged on the run" overstates a green run with a step annotation | Reword |
| F11 | Minor | 5 Data safety | `scripts/cleanup-releases.js:58` | Prune order is commit date, not publish date | Sort by `published_at` |
| F12 | Minor | 1 Security | `.github/workflows/build.yml:17-18` | Checkout keeps the write token in `.git/config` during `npm ci` | `persist-credentials: false` |

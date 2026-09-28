# Code Review — ComixManagementTool — Full Audit (deferred "proper audit")

## Header

```
Reviewer: Senua (Code Reviewer)
Date: 2026-09-28
Tool: ComixManagementTool
Scope: WHOLE CURRENT TREE at HEAD dd2faac (package.json version 1.9.7)
Type: Full-codebase audit requested by Sergei ("speed, bugs, security, etc."), NOT a release gate.
      The Verdict line below certifies NO release — it is the audit's roll-up only.
Files read: main.js, preload.js, renderer/{index.html,app.js}, all of src/*, scripts/*,
            .github/workflows/build.yml, package.json, .claude/settings.json, .gitignore, CHANGELOG.md, CLAUDE.md
External tools present on this machine: 7-Zip 26.03, ImageMagick 7.1.2-31 (+ Ghostscript 10.03.1). D: volume exists.
Method: static reading + throwaway Node probes that call the tool's own modules against synthetic
        fixtures, all under the session scratchpad. Every count states how it was measured.
```

---

## URGENT — active exposure on current v1.9.7

**C1 — A downloaded comic archive can delete arbitrary files on Sergei's disk (path traversal in the CRC-recovery unlink).**
`src/converter.js` `extractArchive()` (lines 113–131). When `7z x` reports one or more `CRC Failed : <name>`
entries (exit code 2), the code parses `<name>` straight out of stderr and runs
`fs.promises.unlink(path.join(destDir, name))` (line 129) **without confining the result to `destDir`.**
`<name>` comes from the untrusted archive. An entry named `..\..\<path>` with a deliberately wrong CRC
therefore deletes a file **outside** the temp extraction dir.

Failure scenario (reproduced): a crafted `.zip`/`.cbz`/`.cbr`/`.rar` with one good page (so the archive
"succeeds", `7z` exits 2) plus a bad-CRC entry named `..\..\PRECIOUS\family_photo.jpg`. Running Convert on
it deleted the real file two directories above the temp dir; the convert still reported `success: true,
outcome: 'multi'`. Probe: `scratchpad/cmt-audit/p8_traversal.js` — "victim exists AFTER convert: false".
This is reached by the ordinary batch Convert path (`startConversion → processFile → extractArchive`), the
single-file review path, and nested archives inside `processDirectoryTree` — no special user action beyond
converting a downloaded file (the tool's whole purpose, incl. GetComics bundles handled by unwrapper.js).

Severity: **Critical** — hits the always-blocking safety floor (out-of-scope file deletion via untrusted
input → machine harm / data destruction). Fix direction: after `path.resolve(destDir, name)`, refuse any
result that does not start with `destDir + path.sep`; skip (don't unlink) anything that escapes. Do the same
containment check anywhere an archive-supplied entry name is turned into a filesystem path.

---

## Summary

Nine dimensions were walked against the whole tree. The command-shape work in the never-reviewed range
(`src/seven-zip.js`, `src/exec.js`, the v1.9.6 `@listfile` change) is **sound against shell/command
injection** — everything spawns through `execFile` (no shell), and operands beginning with `-` are
neutralised with a `.\` prefix; probes with `& ^ % ; @ [ ] % PATH %`, unicode and emoji all passed through
7-Zip untouched (probe `p1_pure.js`, `p2_convert.js`, `p3_listfile.js`). The serious problems are elsewhere:
one untrusted-input path-traversal **deletion** (C1), one destructive **resize** that silently drops pages
stored in subfolders (C2), and a cluster of data-safety/correctness bugs where a conversion is reported
"successful/validated" while the produced CBZ set does **not** faithfully cover the original — after which the
original is offered for (permanent) deletion. Performance is mostly fine (7-Zip store mode keeps image bytes
out of Node RAM, streams for hashing, header-only dimension reads), with two main-process blocking spots.

---

## Rubric

### 1. Security — **Fail**
- **C1** `src/converter.js:113–131` — [Critical] Path traversal → arbitrary file **deletion** via a crafted
  archive's bad-CRC entry name. See URGENT above. Safety-floor violation.
- **m6** IPC surface (`preload.js:14–38` + the delete/exec/rename handlers in `main.js`) — [Minor] The main
  process performs `unlink`/`trashItem`/`rename`/`copyFile`/`execFile` on **any** path the renderer passes,
  with no confinement to a user-chosen root. Safe today only because the renderer loads bundled files under a
  strict CSP with no remote content and no untrusted `innerHTML` (log lines use `createTextNode`, verified).
  Defence-in-depth gap: a single renderer XSS regression becomes arbitrary file delete/exec. Consider a
  main-side allowlist / root check on destructive channels.
- Positives (verified): `contextIsolation:true`, `nodeIntegration:false` (`main.js:66–70`); `setWindowOpenHandler`
  denies and `will-navigate` is prevented (`main.js:82–83`); CSP is `default-src 'self' data:; script-src 'self'`
  (`renderer/index.html:5–6`); no `shell.openExternal`, no `eval`/`new Function`; no secrets in the repo, none logged;
  `where.exe` is resolved by absolute System32 path to avoid CWD hijack (`src/tools.js:35–64`); execFile everywhere,
  no command injection found. `sandbox` is not set explicitly — the Electron 29 default (sandbox on) applies; fine,
  but pin it explicitly for clarity.

### 2. Correctness & Logic — **Concerns**
- **M1** `src/converter.js:895–905` (with `src/renamer.js` `buildOutputName`) — [Major] Two generic-named
  groups inside ONE archive can map to the **same** output name, and the second is then treated by the
  skip-if-exists branch as "already converted" and **never packed** — its pages are dropped, yet the archive
  still returns `success/validated:true`, making the original deletion-eligible. Reproduced (probe `p2_convert.js`,
  case E): subfolders `Chapter 1` (2 imgs), `Part 1` (3 imgs), `Chapter 2` (1 img) all under one `.zip` →
  outputs `#001` (from Chapter 1) and `#002` (from Chapter 2); `Part 1` logged `SKIP (exists)` and its 3 pages
  are lost. `buildOutputName` collapses `Chapter 1`/`Part 1`/`Issue 1`/`001`/`1`/`Ch 1` all to `#001`. Fix
  direction: de-duplicate output names *within a single conversion run* (append ` (1)`, ` (2)` …) instead of
  reusing the cross-run skip-exists path; or fail the archive's `success` if any group was skipped by collision.
- **m2** `src/converter.js:127–135` + `src/validator.js` — [Minor] CRC-failed pages are deleted and the
  resulting **fewer-page** CBZ is validated against the *reduced* count (`group.imageCount` recomputed from what
  survived), so it "passes" and the original — the only copy of the dropped pages — is offered for deletion.
  User is warned in the log, but the delete modal still lists the file as safely deletable.

### 3. Crash / Stability Safety — **Concerns**
- **M5** `src/converter.js:955–1011` (`findOrphanedOriginals`) — [Major] Runs after every conversion and walks
  the **entire library** with recursive `fs.readdirSync` and **no event-loop yield** (unlike `src/scanner.js`,
  which yields every 250 files), then spawns one `7z l` per matched orphan. On Sergei's real use (large comic
  folders) this freezes the main-process/UI for the duration of the post-scan. Fix: yield periodically as the
  scanner does, and/or parallelise/limit the `canOpenCbz` checks.
- Positives: `before-quit` aborts every controller (`main.js:102–113`); close always quits (`main.js:97`); IPC
  sends guard `isDestroyed()`; pack→validate→rename leaves only an ignored `.cbz.tmp` on crash.

### 4. Performance — **Concerns**
- **m4** `src/converter.js:298–322` (`retryCorrupted`) — [Minor] After every PDF, opens and reads the first 3
  bytes of **every** output JPEG via synchronous `openSync/readSync/closeSync` on the main process; for a
  many-hundred-page artbook this blocks the event loop. Make the JPEG-signature check async / batched.
- **m3** `src/converter.js:11` `PDF_DPI = 170` — [Minor, product trade-off] Docs claim 300 DPI (see dim 8).
  170 is a speed/quality choice; flagging the cost, not deciding — that's Sergei's call. Whatever is chosen,
  code and docs must agree.
- Positives: 7-Zip store mode keeps image bytes out of Node RAM; PDF extraction is parallelised per-CPU with a
  serial missing-page retry; resize reads dimensions from header bytes instead of spawning `magick identify`;
  duplicates hashing is size-bucketed and streamed (`src/duplicates.js`). No whole-image-into-RAM paths found.

### 5. State & Data Safety — **Fail**
- **C2** `src/resizer.js:236–245, 263–267, 335` + `main.js:411–429` — [Critical] Resizing a CBZ whose pages
  live in **subfolders** silently drops those pages, and confirming "Replace" then overwrites the original with
  the page-stripped copy → data loss. Root cause: extraction uses `7z e -o.. -y -i!*.jpg` (extract-flat with an
  include filter), which is **non-recursive** — it extracts only root-level images. Verified at the 7-Zip level
  (probe: a CBZ with `000 cover.jpg` + `Ch1/…` + `Ch2/…` → `7z e -i!*.jpg` landed **only** `000 cover.jpg`) and
  through the tool (`p4_resize.js`): a `cover+chapters.cbz` produced a "resized" replacement containing **only**
  the cover, marked ready to replace. Validation cannot catch it because `validateCbz(tmpCbz, allFiles.length)`
  measures against the *already-incomplete* extracted set (see m7), not the original's true entry count. If the
  library sits on a different volume from `%TEMP%` (D: exists here), the confirm also takes the non-atomic branch
  in M2. Fix direction: extract with paths + recurse (or enumerate and repack the full tree), and validate the
  repack against the original CBZ's own image-entry count.
- **M2** `main.js:411–429` (`resize:confirm`) — [Major] The cross-volume fallback does
  `copyFile(tmp, original)` **in place** (non-atomic; `copyFile` truncates the destination before writing), with
  no destination-side temp+rename and no re-validation. `src/resizer.js:311` always writes the resized tmp to
  `os.tmpdir()`, so whenever the library is on another drive **every** confirm takes this branch. A crash /
  power loss mid-copy leaves the original truncated, and the next launch's `cleanupOrphanedTempDirs`
  (`main.js:19–28`, sweeps `cbz_*`) removes the `cbz_resized_*` tmp — both copies gone. Mechanism reproduced in
  `p7_dataloss.js` (5 MB original truncated to 10 bytes by an interrupted in-place write). Safe pattern: write
  the temp CBZ to a sibling file **on the destination volume**, then `rename` (atomic same-volume replace);
  never `copyFile` over the only surviving original.
- **m1** `main.js:826–844` (`conversion:deleteOriginals`) — [Minor] Convert-flow original deletion uses
  permanent `fs.unlink`, whereas every other delete feature (duplicates, unwrap, folder-packer) uses
  `shell.trashItem` (Recycle Bin, recoverable). This is the *one* delete gated on the fooled validation (M1/m2),
  and it is unrecoverable. Route it through `shell.trashItem` too.
- **m7** `src/resizer.js:335` — [Minor] Validates the repack against `allFiles.length` (post-extract count),
  not the original CBZ's real entry count, so any extraction shortfall (C2) is invisible to validation. (Fold
  into C2's fix.)

### 6. Input Handling — **Concerns**
- **M4** `src/converter.js:705` / `src/resizer.js:314` / `src/folder-packer.js:301` (the `@listfile` pack) —
  [Major] Page filenames with a **leading or trailing space** break the pack: 7-Zip trims each listfile line,
  so the referenced file isn't found and the pack fails (`7z` exit 1, "cannot find the file specified").
  Isolated in `p3_listfile.js`: `" 004 leading space.jpg"` and `"011 trailing.jpg "` both FAIL while unicode,
  emoji, `& ^ % ; @ [ ] # ~` all pass. It fails **safe** (the file errors out, original is not deleted), but
  such archives are simply unconvertible. Fix direction: don't reference names through a newline-delimited
  listfile when they can carry edge whitespace — use `-spf` / an explicit separator, or pass basenames as
  neutralised operands.
- Verified robust: absolute/UNC/`\\?\` and `[`,`]`,spaces,`&`,`%`,`^`,unicode operands (probe `p1`/`p2`);
  >260-char source paths convert (probe `p6`, 413-char path succeeded); switch-shaped operands neutralised.

### 7. Maintainability — **Pass**
- Modules are small and single-purpose; the `seven-zip.js`/`exec.js` split is clean and well-commented. Note
  `src/folder-packer.js` lacks the pack→validate step the converter has (feeds M3); worth converging on one
  validated pack helper.

### 8. Doc/Code Drift — **Concerns** (no Critical on its own)
- **m3-doc** `CLAUDE.md` External-Dependencies + `src/converter.js:11` — 300 DPI in docs vs `PDF_DPI = 170` in code.
- `CLAUDE.md:14,36,85,121` — [Minor] adm-zip described as installed/bundled and "used for packing and
  validation"; it is **not** a dependency, is **not** in `node_modules`, and nothing imports it — packing is
  7-Zip `a -tzip -mx=0`. (Prior report F8, still open.)
- `CHANGELOG.md:4–5` — "date-stamped version tags" (tags are semver `vX.Y.Z`). (Prior F6, open.)
- `CHANGELOG.md` v1.9.7 "Publishing is CI-only: `npm run release` … refuse to run outside GitHub Actions" —
  `scripts/release.mjs` refuses **unconditionally**, CI included. (Prior F5, open.)

### 9. Build & Release Hygiene — **Concerns**
- **M-F1 (carried, still open)** `.github/workflows/build.yml:36–50` + `scripts/ci-publish-guard.mjs` — [Major]
  The run can finish green having published nothing (electron-builder's silent skip; the tag/version and the
  release-assets check are still absent). `build.yml` is unchanged since the v1.9.7 report.
- **m8** `.github/workflows/build.yml:23` — [Minor] Node pinned to `20` (upstream EOL 2026-04-30);
  `actions/checkout@v4` keeps `persist-credentials: true` (token in `.git/config` during `npm ci`). (Prior F9/F12.)
- **m9** `scripts/cleanup-releases.js:58` — [Minor] Prune order is `created_at` (commit date), not `published_at`. (Prior F11.)
- Verified clean: version bumped to 1.9.7; lockfile diff is only the two `version` fields; `scripts/` not in the
  packaged `files` whitelist; no `upload-artifact` step; token scope `contents: write` only.

---

## Status of the v1.9.7 report's findings (not re-derived)

| Prior | Sev | What | Status at dd2faac |
|-------|-----|------|-------------------|
| F1 | Major | CI can go green publishing nothing | **Open** — build.yml unchanged (carried as M-F1) |
| F2 | Major | `.gitignore` inline comment made `scratch/` literal | **Fixed** — `scratch/` on its own line; `git check-ignore` matches |
| F3 | Major | settings.json deny-list gaps (`--tags`, `-f`, `--mirror`, publish-always) | **Fixed** — all denied at dd2faac (note: bare `+refspec` push form still not covered) |
| F4 | Minor | darwin removal filed under "Fixed" | **Fixed** — moved to "Changed" |
| F5 | Minor | release refuses "outside Actions" wording | **Open** — refuses unconditionally |
| F6 | Minor | "date-stamped version tags" | **Open** |
| F7 | Minor | pre-v1.9.3 history pointer wrong | **Open** (unverified in detail — static) |
| F8 | Minor | adm-zip described as used | **Open** — not installed/imported |
| F9 | Minor | Node 20 EOL | **Open** |
| F10 | Minor | "flagged on the run" overstates | **Open** (unverified — static) |
| F11 | Minor | cleanup sorts by created_at | **Open** |
| F12 | Minor | checkout keeps write token | **Open** |

---

## Prioritized fix list (top 10)

| # | Sev | Tag | Where | Fix | Size |
|---|-----|-----|-------|-----|------|
| 1 | Critical | security / data-safety | `src/converter.js:113–131` | Confine every archive-supplied entry name with `path.resolve` + `startsWith(destDir+sep)` before unlink; skip escapers | S |
| 2 | Critical | data-safety | `src/resizer.js:236–245,335` + `main.js:411–429` | Extract recursively (keep tree), repack the full page set, validate against the ORIGINAL's entry count | M |
| 3 | Major | data-safety | `main.js:411–429` + `src/resizer.js:311` | Write resized tmp on the destination volume; atomic same-volume `rename`; never `copyFile` over the only original | S |
| 4 | Major | bug / data-safety | `src/converter.js:895–905` | De-dupe output names within a run (append ` (n)`); don't let a name collision read as "already converted" | S |
| 5 | Major | bug / data-safety | `src/folder-packer.js:258–325` | Pack the full recursive image set; add pack→validate before offering Delete Folder | M |
| 6 | Major | bug | `src/converter.js:705`, `resizer.js:314`, `folder-packer.js:301` | Handle leading/trailing-space page names (don't rely on newline listfile trimming) | M |
| 7 | Major | speed / stability | `src/converter.js:955–1011` | Yield during the library walk (as scanner.js) and bound the `canOpenCbz` spawns | S |
| 8 | Minor | data-safety | `main.js:826–844` | Route convert-flow original deletion through `shell.trashItem` like the other delete features | S |
| 9 | Minor | speed | `src/converter.js:298–322` | Make the post-PDF JPEG-signature check async/batched | S |
| 10 | Major | security / release | `.github/workflows/build.yml` + `ci-publish-guard.mjs` | Assert ref is a tag == `v`+version; strict release-assets check before prune (carried F1) | M |

---

## Verdict

- Total Critical: 2 (C1, C2)
- Total Major: 5 new (M1, M2, M3, M4, M5) + 1 carried open (F1)
- Total Minor: 7 new (m1–m9 span; new: m1,m2,m3,m4,m6,m7,m9) + carried-open prior minors (F5–F12 as tabled)

This is a full audit, not a release gate; the line below is the audit roll-up and **certifies no release**.
Two Critical findings are open and one is a safety-floor violation (C1).

**Verdict:** RELEASE BLOCKED

| # | Sev | Dim | file:line | Finding | Must fix before any release |
|---|-----|-----|-----------|---------|------------------------------|
| C1 | Critical | 1 Security | `src/converter.js:113–131` | Crafted archive's bad-CRC `..\..\` entry name → arbitrary file deletion | Confine resolved path to destDir; skip escapers |
| C2 | Critical | 5 Data safety | `src/resizer.js:236–245,335`; `main.js:411–429` | Resize drops subfoldered pages, validation fooled, destructive replace | Recursive extract + repack full set + validate vs original count |

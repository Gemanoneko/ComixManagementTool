# Code Review — ComixManagementTool v1.10.0

## Header

```
Reviewer: Senua (Code Reviewer)
Date: 2026-09-29
Tool: ComixManagementTool
Release: v1.10.0 (package.json still 1.9.7 — Sully bumps at release)
Commit range: v1.9.7..d46269d (branch wip/audit-fixes, tree clean)
Files changed: 19 files, +3204 / -343 (code only: 16 files, +2592 / -342 —
               main.js, preload.js, renderer/{app.js,index.html,styles.css}, src/*)
Stand-down dimensions: none
External tools used by probes: 7-Zip 26.03 (system copy, same version as vendor/ and the
               installed v1.9.7's bundled 7z.exe), ImageMagick 7.1.2-Q16-HDRI.
Method: static reading of the whole range, then throwaway Node probes that call the tool's own
        modules from a `git archive d46269d` snapshot, all under
        scratchpad\review-v1100\ (fixtures in fx\, app temp redirected to tmp\approot).
        Ender's cmt-fix2..10 evidence was read, not relied on; every claim below was re-run.
Not done: no live app launch (a visible window steals focus — ProcessRules § Desktop App/GUI
        Rules; Futaba is running the app). Cross-drive Replace was simulated by forcing
        EXDEV (writes were limited to the scratchpad, so no real D: library).
```

---

## Summary

The range is the audit-fix branch: C1, C2, M1–M5 and case F from my 2026-09-28 full audit, rulings
1–26 (end-of-run failure blocks for Convert/Resize, the folder-pack interactive fix flow with the new
`folderpack:previewRenames` / `folderpack:renameEntry` channels, device-name and trailing-space naming
rules, a per-userData temp folder, a single-instance lock, a journalled startup sweep of
`.resize.tmp` siblings, the ruling-24/26 "existing CBZ that isn't this file's fails the file"
logic with a plan pass and an undo). **Every audit finding in scope is really fixed**, each one
re-proven with a probe (table below). Command construction stays injection-safe, the new IPC is
validated in the main process and held up to an adversarial probe, long/odd paths work in all three
flows, and the stream-error crash is fixed (positive control reproduced the old crash).

The red-team pass found **no Critical**. It found one new **data-loss path** in the ruling-24/26
plan pass (N1): the plan pass caches each existing-output check by path, but the real pass can hand
that path to a *different* source, which then inherits the other source's "valid" and is skipped
as done. Reproduced end to end: the bundle is reported converted and offered for (permanent,
ruling 16) deletion while two of its pages are in no CBZ. I grade it **Major, not Critical**: it
needs a hierarchical bundle with a nested non-CBZ archive name-colliding with two same-named tree
outputs, **plus** a pre-existing `… (1).cbz` holding exactly another group's pages — state that
only a prior partial failure or manual file moves produce — and the user must still confirm the
delete. That is the same class I graded Major for M1 in the audit, which was *easier* to reach. The
same root cause also makes some bundles fail on every re-run (N2). Shipping v1.10.0 is still
strictly safer than staying on v1.9.7, which carries live C1 (safety floor) and C2.

### Audit fixes — verified

| Audit | Status | Evidence (re-run this review) |
|---|---|---|
| **C1** traversal delete | **Fixed** | `p3_c1_traversal.js`: 8 bad-CRC names (`../`, `../../`, `..\..\`, absolute, drive-relative `C:…`, `.. .\`, `...\`, inside control). All victims survive; the four that resolve outside fail closed with the "unsafe" cause; the others resolve inside the extraction dir (Node's `\\?\` namespacing makes `.. .` / `...` literal). |
| **C2** resize drops subfolder pages | **Fixed** | `p4_resize.js` A: cover + `Ch1\` + `Ch2\` (same page names), ComicInfo, `.jxl`, empty folder, explicit dir entries, `Vol 1 \`, `a:b.txt`, `con.txt`, `[1]`, unicode, leading space → after Replace the entry set is identical (16 → 16) and every untouched entry is byte-identical (CRC). Truncated CBZ fails; `A.jpg`+`a.jpg` is never offered. |
| **M1** name collision drops pages | **Fixed** | `p5_convert_fixes.js` Gen.zip: `Chapter 1`/`Part 1`/`Chapter 2` → three CBZs, all pages stored. |
| **M2** in-place cross-drive copy | **Fixed** | `p4_resize.js` D: forced EXDEV → sibling + fsync + atomic rename; a copy that dies mid-way leaves the original intact and removes the sibling. |
| **M3** folder-pack drops files | **Fixed** | `p6b_m3.js`: `.txt`, `.jxl`, nested empty folder, a `Thumbs.db.d\` folder and a *folder* named `Thumbs.db` all packed; `Thumbs.db`/`desktop.ini` *files* left out; exact-copy check passes. |
| **M4** edge-space page names | **Fixed** | `p5` Space.zip and `p7_names.js` (`@`, `-`, `%`, `!`, `;&^`, `~1` names) convert through the quoted listfile. |
| **M5** orphan walk blocks UI | **Fixed** | Static: async `readdir` + `setImmediate` every 250 units (`src/converter.js:1382–1395`). |
| **Case F** truncated nested copy | **Fixed** | `p5` Nest.zip: a truncated `Issue One.cbz` at the destination is replaced by a validated full copy (`.tmp` → validate → rename). |
| m7 | Fixed | Folded into C2 (repack validated against the original's own listing). |
| m1 | Superseded | Ruling 16 keeps the permanent delete. |
| F1 (fix list) >260 cwd crash | **Fixed** | `p11_exec_longcwd.js`: rejects cleanly with ENOENT. Positive control (raw `execFile`, no pipe listeners) → uncaught `read ENOTCONN`. |

---

## Rubric

### 1. Security — **Pass**
- No new command-injection surface: every spawn is still `execFile` through `src/exec.js`; listfiles
  quote every line and refuse `"`/CR/LF (`src/seven-zip.js:116–123`); `7z rn` runs with `-spd`
  (wildcards off) from a listfile (`src/resizer.js:656`); operands keep the `-` neutraliser.
- New IPC is confined in the main process: `renameEntry`/`previewRenames` accept only a folder from
  the last scan, a normalised relative path that stays inside it, an existing entry, and a name that
  really needs fixing (`src/folder-packer.js:674–737`). `p6_folderpack.js` threw 11 requests at it
  (not-scanned folder, `..`, mid-path `..`, absolute, `/`, drive-relative, good name, non-string,
  plus three real fixes): every escape was refused, the victim was untouched, a sibling `002.jpg`
  was not overwritten (the fix became `002 (1).jpg`).
- `shell:openFolder` is `showItemInFolder` (never executes). The new failure-block buttons use it for
  file paths; no new code sends a *file* path to `shell:openPath` (checked every new `appendLog`
  caller).
- contextIsolation on, nodeIntegration off, CSP unchanged, no `innerHTML` with data in the new
  renderer code, no secrets. The audit's m6 (destructive channels accept any path) stays open — Minor,
  carried.

### 2. Correctness & Logic — **Concerns**
- **N2** `src/converter.js:804–816` with `1192–1200` — **[Major]** The ruling-24/26 plan pass skips
  nested non-CBZ archives, so it claims output names in a different order from the real pass. A bundle
  holding a nested `X.zip` and a folder `X` at the same level converts on the first run
  (nested → `X.cbz`, folder → `X (1).cbz`) and then **fails on every re-run** with
  `An existing "X.cbz" doesn't match this file`, whose Fix line tells Sergei to move or rename the
  tool's own output. Reproduced: `p2_rerun_false_conflict.js`. Fails safe (nothing written, nothing
  offered), but a re-run of such a bundle is permanently broken and the advice is misleading. Same
  root cause and same fix as N1.
- m2 (carried, Minor): CRC-failed pages are dropped and the reduced CBZ validates; the original is
  offered (seen again in `p3`: four archives converted without their bad-CRC entry).

### 3. Crash / Stability Safety — **Pass**
- F1 fixed with a positive control (above). Single-instance lock is the standard pattern: the second
  launch quits before any sweep, and every startup delete is inside the lock's `else`
  (`main.js:112–130`). Note: Ender's lock probe stubbed `requestSingleInstanceLock → true`, so a real
  double launch has not been exercised — worth one check in Futaba's pass.
- Startup sweep verified (`p12_sweep.js`): only journalled, exactly-named `<x>.cbz.<8 hex>.resize.tmp`
  regular files whose original exists as a file are deleted; user files, folders, upper-case hex,
  and siblings whose original is missing or is a folder are all kept; the journal is emptied.

### 4. Performance — **Pass**
- By design (rulings 3/24) a re-run now re-extracts each source, runs `7z t` on its existing CBZ and
  CRCs every page (PDFs are re-rendered). Heavier than v1.9.7's open check, but it is the price of the
  guarantee; noted, not a finding. m4 (sync JPEG-signature scan after PDFs) carried, Minor.

### 5. State & Data Safety — **Concerns**
- **N1** `src/converter.js:237–243` (`checkOnce`), `1192–1200`, `876–890` — **[Major]** The plan pass
  caches each existing-output check by **path only** (`tree.checked`), and the real pass reuses it.
  Because the real pass lets nested non-CBZ archives claim names first, a tree output can land on a
  path the plan checked **for a different source** and inherit that source's `valid`: it is logged
  `SKIP (exists)`, its pages are counted in `pagesDone`, the bundle validates and is offered for
  permanent deletion. The cache ignores even the page count (a 2-page group inherited a 1-page
  group's result). Reproduced (`p1_stale_cache.js`): bundle = nested `Batman Tales.zip` + folders
  `Batman Tales\` (2 pages) and `Batman Tales (1)\` (1 page), with `Foo\Batman Tales (1).cbz` already
  holding the second folder's page → `Foo.zip` reported converted and offered while pages A1, A2 are
  in **no** CBZ. Control without the pre-existing file is correct. Why Major and not Critical: it needs
  that name-collision layout **and** a pre-existing `… (n).cbz` holding exactly another group's pages,
  which only a prior partial failure (for example a nested archive that failed to extract, so it
  claimed nothing) or manual moves produce, and the user must confirm the delete. It breaks the
  ruling-23.1 guarantee, so it should be the first thing fixed next cycle. Fix direction: don't reuse a
  plan-pass result for a path unless the same source claimed it (key the cache by path + source), or
  make the plan pass claim names in the real pass's order.
- **N3** `src/converter.js:135–142` with `892–897`, `950–956`, `1312–1313` (unchanged in behaviour
  since v1.9.7, re-implemented in this range) — **[Major, pre-existing]** An existing CBZ at the
  output name is classed `unreadable` whenever `7z t` + image count fail **and** `canOpenCbz` finds no
  IMAGE_EXTS entry, and it is then **permanently unlinked with no prompt** and replaced. That
  includes an intact CBZ whose pages are JPEG XL/HEIC/JP2 (not in IMAGE_EXTS), and — for a PDF source
  only, since archives fail at extraction first — any existing CBZ when 7-Zip is missing (`canOpenCbz`
  returns false). Reproduced (`p10_unreadable_delete.js`): `Saga.cbz` holding three `.jxl` pages was
  deleted and replaced by `Saga.zip`'s two JPEGs. This contradicts the intent of ruling 24 (an
  existing CBZ with other pages fails the file, nothing written). Major rather than Critical: it is
  pre-existing (holding v1.10.0 does not protect Sergei from it), and it needs a same-named source
  sitting beside a non-standard-page CBZ. Fix direction: treat only "7-Zip can't open it at all" as
  replaceable, and route every other invalid state to the existing-mismatch failure.
- Verified safe: resize Replace (C2, M2 above); the ruling-26 undo removes only CBZs this run wrote
  and only folders it created (`p5` Mix.zip: `A2.cbz` removed, the pre-existing `Inner.cbz` and
  pre-existing folders untouched); folder-pack cleanup unlinks only targets it resolved as free; the
  fix-flow rename never replaces an existing entry; the per-userData temp folder is outside older
  versions' `cbz_*` sweep; the startup sweep (dim 3).

### 6. Input Handling — **Concerns**
- Verified robust: 372-character library path with `[ ] & % ^ Ünï`, 180-character internal folders,
  nested archive — Convert, Resize + Replace and folder-pack all succeed (`p9_longpath.js`);
  device names, trailing spaces/dots, `a:b`, leading spaces round-trip (`p4`, `p6`).
- **m-a** `src/seven-zip.js:146–157` (`errorLine`) — [Minor] For a truncated CBZ 7-Zip's stderr starts
  with a bare `ERRORS:` header, and that is what the new Resize failure block shows as the message
  (`"C.cbz" — ERRORS:`, seen in `p4`). Skip `ERRORS:`/`WARNINGS:` header lines.
- **m-e** `src/converter.js:419,442` and `src/resizer.js:560–577` — [Minor] ImageMagick treats `%d`
  in file names as a template and mishandles `~1`-shaped names. Resize fails safe (verified: `mogrify`
  deletes `p%d.jpg`/`PROGRA~1.jpg` in the temp copy, the pack listfile then misses them and the file
  fails — `p7_names.js`, `q2_mogrify_tilde.js`). The PDF path is pre-existing: `Vol %d.pdf` made
  ImageMagick try to read `Vol 0.pdf` … `Vol 4.pdf` (`p8_pdf_percent.js`; it failed only because
  those siblings didn't exist).

### 7. Maintainability — **Concerns** (no Critical on its own)
- **m-b** `src/converter.js:996–1003` — [Minor] The `packToCbz` doc says `fs.rename` "fails if the
  destination exists" on Windows; Node replaces it (verified). No data loss follows today, but the
  tree path's "could not be removed → SKIP" logic and future edits rest on that false premise.
- **m-d** `IMAGE_EXTS` is defined four times (`converter.js:17`, `folder-packer.js:25`,
  `resizer.js:15`, `validator.js:7`) and `longPath` twice (`resizer.js:32`, `seven-zip.js:129`) —
  [Minor] one drifting copy becomes a validation hole.
- The plan/real two-pass design with a shared mutable `tree` and a path-keyed cache is the root of N1
  and N2; worth simplifying when they're fixed.

### 8. Doc/Code Drift — **Concerns** (no Critical on its own)
- **m-c** `src/converter.js:1204` — [Minor] `PLACEHOLDER wording — Judy to check (ruling 26)`: the
  "Removed N CBZs this run had written for this file." line ships unreviewed.
- **m-f** repo `CLAUDE.md` — [Minor] stale in several places: Versioning (`:110–116`, "bump
  automatically after every code change" — contradicts Sully-owned release bumps); adm-zip described
  as installed, bundled and used for packing (`:14, 36, 85, 121`, carried F8); 300 DPI / PNG
  (`:56, 80, 125`) vs `PDF_DPI = 170` and JPEG q90 (carried m3-doc); "paths are hardcoded in
  converter.js" (`:58`, they're detected in `tools.js`); "CBZ images are stored flat" (`:122`,
  folder-pack now keeps the folder tree and Resize preserves it); the IPC table (`:98–108`) lists 7 of
  ~45 channels; the Architecture list omits resizer, folder-packer, unwrapper, temp, winname and
  others.
- CHANGELOG has no v1.10.0 entry yet (Sully's release step). Carried wording items F5, F6, F7, F10
  are unchanged.

### 9. Build & Release Hygiene — **Concerns**
- Version not yet bumped (expected; Sully). No new dependencies, lockfile untouched, the `files`
  whitelist (`src/**`) picks up the new modules, nothing sensitive packaged, the settings.json
  deny-list now covers the `+refspec` push form (audit note closed).
- **M-F1** (carried) `.github/workflows/build.yml` — [Major] CI can still finish green having
  published nothing; file unchanged since the audit.
- **m-g** `scripts/prepare-vendor.js:18` — [Minor] The bundled 7-Zip is whatever is in
  `C:\Program Files\7-Zip` on the build machine or CI runner, unpinned and unchecked. The new code's
  extraction-name model and `7z rn` behaviour are documented as checked against 26.03, and the
  symlink-traversal fixes need ≥ 25.00. The installed v1.9.7 bundles 26.03, so no live exposure seen.
  Add a minimum-version assert.
- Carried Minors unchanged: m8 (Node 20, checkout credentials), m9 (cleanup sorts by `created_at`),
  F11, F12.

---

## Patterns

The recurring failure mode for this tool is still "a page silently stops counting while the archive
reads as validated": m2 and M1 in the audit, N1 here. Each fix adds another counting rule; the durable
fix is one invariant checked at the end: every page of the source is found, by CRC, in a CBZ that this
run validated or re-validated for *this* source.

---

## Verdict

- Total Critical: 0
- Total Major: 4 (new: N1, N2, N3 — N3 pre-existing behaviour; carried: M-F1)
- Total Minor: 7 new (m-a … m-g) + carried open (m2, m3-doc, m4, m6, m8, m9, F5–F8, F10–F12)

No open Critical finding; the safety floor is intact (C1 fixed and re-proven, no out-of-scope write
or delete path, no unsafe Electron config, no secrets). N1 is the finding to put in front of Sergei
first when he's back.

**Verdict:** RELEASE CLEAR

| # | Sev | Dim | file:line | Finding | Next cycle |
|---|-----|-----|-----------|---------|------------|
| N1 | Major | 5 Data safety | `src/converter.js:237–243`, `1192–1200` | Plan-pass check cache reused for a different source → bundle offered for delete with pages in no CBZ (rare preconditions) | Key the cache by path + source, or match the claim order |
| N2 | Major | 2 Correctness | `src/converter.js:804–816` | Nested `X.zip` + folder `X` → every re-run fails with a false "existing X.cbz doesn't match" | Same fix as N1 |
| N3 | Major | 5 Data safety | `src/converter.js:135–142`, `892`, `950`, `1312` | Intact CBZ with non-IMAGE_EXTS pages (or any CBZ when 7-Zip is missing, PDF source) deleted as "unreadable" without a prompt | Only "can't open at all" is replaceable; everything else fails the file |
| M-F1 | Major | 9 Build | `.github/workflows/build.yml` | CI can go green having published nothing (carried) | Assert tag == version and release assets exist |

Probes: `C:\Users\AnGeLZzZ\AppData\Local\Temp\claude\C--Antigravity-Projects-Studio-Illuminati\d9e4d68b-5090-4988-b222-b72ad37552b1\scratchpad\review-v1100\`
(`p1`–`p12`, `q1`–`q2`; run with `TEMP`/`TMP` pointed at `review-v1100\tmp`).

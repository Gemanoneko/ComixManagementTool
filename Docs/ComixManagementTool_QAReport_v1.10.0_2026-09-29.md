# ComixManagementTool — QA Report v1.10.0 — 2026-09-29

**Tester:** Futaba (QA / Dogfooder)
**Scope:** behavior half of dual clearance for v1.10.0 (Senua covers construction in parallel). Build under test: branch `wip/audit-fixes`, commit `d46269d`, tree clean at start. `package.json` still says 1.9.7 (Sully bumps at release), so the running app's label reads `v1.9.7`; treated as v1.10.0.
**Brief:** use it the way Sergei would, list everything that gets in the way, tag Blocker / Major / Minor per ProcessRules § Severity definitions (Futaba vocabulary: Blocker = breaks the core flow Sergei uses).

## Entry-gate receipt (qa-handoff skill)

```
Entry-check receipt: comix-management-tool v1.9.7 @ d46269d (dirty: N) — pre-qa n/a, post-build n/a, check-electron n/a, check n/a, test:smoke n/a
```

Re-derived at the end of the pass: same HEAD `d46269d`; the dirty flag read `Y` only because Senua's untracked `Docs/ComixManagementTool_CodeReview_v1.10.0_2026-09-29.md` appeared in the tree meanwhile. `git status --short` shows no tracked file changed. No declared check scripts exist in `package.json`, so all five read n/a (unchanged from the v1.9.7 report).

## Build under test and isolation

- Built with `npm run prepare-vendor && npm run pack -- --dir --config.directories.output=<scratchpad>\qa-v1100\pack` (no NSIS installer, output in the scratchpad so the repo's `dist/` was not touched). `npm ci`, `npm run build`, `npm run release` and the installer were never run.
- The packed `app.asar` was extracted and compared with `git show HEAD:<file>` for `main.js`, `preload.js`, `converter.js`, `resizer.js`, `folder-packer.js`, `app.js`, `index.html`, `styles.css`, `winname.js`: identical once CRLF is normalised. Because `--dir` does not emit `app-update.yml`, the Update button in my build reports "Update error: ENOENT …app-update.yml" — an artifact of my build flavour, not a defect.
- Every instance ran with its own throwaway `--user-data-dir` under the scratchpad (45 different ones). Sergei's real profile folders (`%APPDATA%\comix-management-tool`, `%APPDATA%\ComixManagementTool`) had no file newer than 2026-09-28 20:16 when I finished; the installed app was never launched. `tasklist` showed no ComixManagementTool process before the first launch and none after the last.
- Windows were created hidden (Electron paused by `--inspect-brk`, a QA shim then forced `show:false`; no app file was modified), so no test instance took focus. For screenshots the window was shown at opacity 0 without activation. The one exception is the double-launch test, which by design restores and focuses the first window.
- Explorer and Recycle Bin calls were stubbed in the main process (`shell.openPath`, `shell.showItemInFolder`, `shell.trashItem`, the last one moving the item into a scratch folder) so no Explorer window opened and nothing went into Sergei's Recycle Bin. Convert's permanent delete (`fs.unlink`) was left real, on synthetic files only.
- All test data is synthetic, built in `qa-v1100\lib-*` (ImageMagick images, 7-Zip / WinRAR `Rar.exe` / Python `zipfile` archives, PDF via ImageMagick). The app was never pointed at anything outside the scratchpad. The preset buttons (`Y:\…`, `I:\…`) were never clicked.
- Interaction was done at DOM level in the renderer (real `click()` handlers, real IPC, real 7-Zip / ImageMagick), because native folder pickers cannot be driven. Closing was done with `taskkill /PID` without `/F` (WM_CLOSE, the same message as the (x) button).
- Scratchpad: `C:\Users\AnGeLZzZ\AppData\Local\Temp\claude\C--Antigravity-Projects-Studio-Illuminati\d9e4d68b-5090-4988-b222-b72ad37552b1\scratchpad\qa-v1100\` (scripts `t-*.mjs`, `build-*.mjs`, results in `results\`). My own `%TEMP%\ComixManagementTool-<hash>` folders were removed at the end (45).

## Result summary

Blocker: 0. Major: 3. Minor: 15 (grouped below). Pattern alerts: 4. No finding breaks the core flow Sergei uses; every Major is present in v1.9.7 as well (none is a regression), but Major 1 contradicts a rule Sergei wrote (ruling 23) as it is worded, so Jane should decide whether that rule was meant only for the twin-name case.

## What was tested and how (against the brief's "Must cover")

### 1. Core flows end to end

| Area | How | Result |
|---|---|---|
| Convert: cbr, zip, brackets in name, PDF (ImageMagick present), split (2 sub-folders), nested bundle (zip + cbz inside + loose pages), deeper bundle-in-bundle, wrapper folder, manga naming | Library C1/C3, real run, then independent oracle: for every original offered for delete, 7-Zip listing (size + CRC of each page) checked against the CBZs on disk | All produced valid CBZs (`7z t` ok); page multisets covered (see Major 1 for the exceptions). PDF: 3 pages. Deep path 349 characters: converted (N1 fixed). |
| Convert delete offers | Keep and real Delete All; needs-review modal Keep / Delete / Delete All Remaining / Open Folder / Convert | Deleted set was exactly the offered set (8 of 8 in the re-run pass); nothing else touched. Review flows work (see Minor 8). |
| Resize + Replace | Library R1 (14 CBZs) with pages up to 5300 px, explicit and implied folders, empty folder, non-page files, trailing-space folder, `a:b.txt`, `con.txt`, `dir?\x.txt`, spaces-only name, `...`, `CON.`, `nul`, 349-character path, corrupt file; Discard run, then Replace All run | Discard left every file unchanged (same size, same entry list) and no temp copy. Replace All: 7 of 7 replaced, `7z t` ok, entry names exactly as the original (checked per file), oversized pages now 4500 px on the long side, non-resized entries same size and CRC. Order: see Minor 5. Replacing across drives not testable (one volume), see "Not exercised". |
| Folder-pack | Library F1 (17 ext-folders): images with Thumbs.db / desktop.ini, sub-folders with nested and empty folders, folders named `Thumbs.db` / `desktop.ini`, `con.cbz`, `nul.cbz`, 349-character path, bad names, empty sub-folder, junction, archive inside (rename) | Junk files left out, folders of those names packed (N2 fixed), nested and empty folders kept, `con_.cbz` / `nul_.cbz`, 300+ character path packed (no crash, F1 fixed), a failing folder did not stop the run (7 converted, 9 failed in one run), CBZ contents checked against the source folders. |
| Delete after folder-pack | Delete Folder, Delete All Source Folders (Recycle Bin stubbed) | Source folders moved, CBZs kept, panel updates. |

### 2. Data-safety claims (tried to make the app offer an original whose pages are not all in a CBZ)

- **Held:** unsafe archive paths confined (`..\..\escape.jpg`, `C:\evil2.jpg`, and an entry with a bad CRC named `..\..\x.jpg` next to a decoy file at `%TEMP%\x.jpg`: decoy survived, file failed as "unsafe", nothing on `C:\` root); existing CBZ with the same page count but other pages, or with fewer pages: the file fails, nothing written, not offered (`Diff`, `Short`, `Multi`, `Multi2`, `Wrap\Foo`, `NestBundle`, `Twin\Foo`); `Foo.zip` / `Foo .zip` (one converts, the other fails and is not offered); Resize: no replacement is offered unless the copy matches the original's entry list exactly (collisions and unreadable files refused, originals untouched: size and entry list unchanged); cancelled runs: unreached originals not offered for review (ruling 25: 12 converted, 12 offered, 0 review entries for the other 108); folder-pack failures are never offered for delete and leave no CBZ (locked-file case verified).
- **Did not hold:** see Major 1.

### 3. Fix panels (folder-pack)

Verified on real disk: per-row Fix with Remove and Replace (live preview text, aria-pressed, tooltips); conflict `" (1)"` in preview (`p.jpg ` shows `p (1).jpg` with the conflict badge) and recomputed at rename time (a blocker file created after the preview: `q.jpg.` became `q (1).jpg`, log shows the real name); Fix All modal (title `Rename N Items?`, singular `Rename 1 Item?`, old → new list, Cancel leaves disk untouched, Rename All renames each row in its current mode); auto-repack after the last name of a folder; a nested bad name found only after its parent folder is renamed (`Both.cbz`: row appears after the repack); mixed folder (`Mixed.cbz`: bad name first, then empty sub-folder after the repack lands in the Retry panel); Retry (one) and Retry All (one folder succeeds, one fails again: row updates in place, fresh failure block in the log); rename failure with a locked file (`EBUSY`, message per Judy, Fix re-enabled, works after release); vanished file (`File or folder not found…`); scan again clears all panels; 600 bad names in one folder: panel ready in 0.3 s, toggle preview 79 ms, modal 0.2 s, Fix All plus auto-repack 4.7 s, CBZ holds all 601 files.
Layout: at window widths 800 / 1100 / 1600 every control in the Names, Retry and modal lists was hit-tested at its centre and four inset corners (all hit themselves), no overlap between controls, info block and actions, or adjacent rows, no horizontal clipping or page scroll, long paths wrap (`pre-wrap`) in rows and modal. All new controls are at least 24 x 24. Screenshots for Jane's eyes: `results\f1-panels-1100.png`, `results\theme-default|cyberpunk|comics|manga.png`, `results\theme-modal-*.png`, `results\f1-fixall-modal.png`.
Not reachable on this NTFS: names with `<>:"|?*` or control characters cannot be created even through `\\?\` (verified: ENOENT), so `name-invalid-char` rows could not be produced end to end. The rename logic was unit-checked against the shipped `folder-packer.js` (22 of 23 cases as specified; the 23rd was my wrong expectation) and the tooltips read from the code match Judy's table.

### 4. Judy's Fix-line claim: can an archive tool rename one of two identically named entries?

**No for identical names, with `7z rn`.** Evidence (7-Zip 26.03 from Program Files, scratch CBZ with `001.jpg`, `001.jpg`, `002.jpg`; entry sizes 1517 and 1573):
- `7z rn dup.cbz 001.jpg 001b.jpg` renamed BOTH entries: `001b.jpg[1517] 001b.jpg[1573]`.
- Listing the same source name twice (`001.jpg 001a.jpg 001.jpg 001b.jpg`): both became `001a.jpg`.
- Case-only pair: `7z rn case.cbz A.jpg A-big.jpg` on `a.jpg` + `A.jpg` renamed both to `A-big.jpg`, turning a case collision into an identical-name collision.
- WinRAR `Rar.exe rn` on the same zip: "Bad archive" (no result).
- Works fine for the other two kinds: `Vol 1 \001.jpg` vs `Vol 1_\001.jpg` (`7z rn` renamed only the addressed one) and `CON` vs `con\x.jpg` (renamed).
- The 7-Zip File Manager window was NOT tested (it needs an interactive GUI and would take focus). So "an archive tool can do it" is confirmed for the "two names" and "file and folder" messages only; for "holds X twice" and for case-only pairs the Fix line is unproven, and `7z rn` cannot do it.

### 5. Log wording

- New strings: singular and plural correct everywhere I could trigger (`1 file failed to convert:`, `1 folder failed to pack:`, `1 file failed to resize:`, `Done: 1 folder converted.`, `1 name to fix`, `1 folder to pack again`, `Rename 1 Item?`, `(+1 more)` with the period after the parenthesis in the failure block and none in the summary line, `Cancelled — 10 folders converted before cancel.`). No `(s)` in any new string.
- Old lines still carry `(s)` and `1 <plural>`: see Minor 1.
- Open Folder buttons: 75 in the Fix tab and log, all called `shell:openPath` with a path that exists; the Names row opens the folder holding the entry (`ManyBad.cbz\Ch A`), Retry row the folder, log rows the folder. "Show this file in Explorer": Convert rows (2) and Resize rows (1) called `showItemInFolder` with the failing file (height 24.0 px each). Review modal Open Folder calls `showItemInFolder`.

### 6. Regression (v1.9.7 behaviour)

Sort Comics (moved 2, skipped 1), Find Duplicates (exact, same-name, similar groups; Trash Checked), Fix the Library Flatten (2 folders), Delete Empty Folders, Unwrap Bundles (extract, Delete Original / Delete All Originals), Scan Ext-Folders rename (Category B), theme picker persisted to `settings.json`, Pause / Resume in Convert, Cancel in Convert / Resize / folder-pack, Update button (only the `--dir` artifact above), single-instance and sweeps below, close from every screen. All behaved as in v1.9.7 except where a numbered finding says pre-existing.

### 7. Ruling checks not listed elsewhere

- **Single instance (real double launch, requested by Jane after Senua's review):** first instance launched with a throwaway user-data-dir and its window minimized; a second plain `ComixManagementTool.exe --user-data-dir=<same>` process was started. The second process exited by itself after 156 ms with code 0; the first instance received one `second-instance` event; its window went from minimized to restored, visible and focused; process count stayed 4 to 4; the second PID was gone. A third launch with a different user-data-dir started and ran next to the first (a dev copy beside the installed app does not collide). Everything was then closed and `tasklist` was empty. Caveat: the first instance was created hidden by my QA shim, then minimized; the second-instance handler itself is the shipped code.
- **Startup sweeps:** `resize-pending.txt` with seven lines: only the valid sibling (`X.cbz.0a1b2c3d.resize.tmp` beside `X.cbz`) was deleted; orphan sibling, `keep.tmp`, a folder with the sibling name, non-hex name, `.txt` original and a relative path were left; journal emptied. `cbz_*` items in the install's own temp folder deleted, a non-`cbz_` file kept, and a `cbz_qa_marker` folder directly in `%TEMP%` survived (F5).
- **Device names:** `nul.zip` to `nul_.cbz`; `con.cbr` to `con_.cbz`; `LPT1.zip` to `LPT1_.cbz`; folder-pack `con.cbz\` / `nul.cbz\` to `con_.cbz` / `nul_.cbz`; Category B `Aux.cbr` to `Aux_\`; unwrap `con.cbz` to `con_\`; a re-run offers `con.cbr` / `LPT1.zip` / `nul.zip` as pre-existing.
- **No name ending in a space:** `Vol 2 .zip` to folder `Vol 2\`; unwrap `Foo .cbz` to `Foo\`; Category B `Bar .rar` to `Bar\`; Resize of an archive with `Vol 1 \` keeps the name exactly.
- **Close from every screen:** 12 scenarios, all exited in 520 to 617 ms with no helper left: idle on each of the 5 tabs (522 / 530 / 533 / 538 / 543 ms), mid-Convert (617), Convert paused (553), Resize with 7-Zip stuck on a password CBZ (540), folder-pack Convert running (586), Fix All confirm modal open (525), plus earlier closes with the delete modal open and the resize modal open. Two scenarios (Scan Ext-Folders running, resize modal via `lib-r1`) did not reach the busy state I intended (scan finished first; nothing left to resize), so the busy-scan and resize-modal closes were only covered indirectly (a resize modal was open during another close, see t-resize2). No temp `.tmp` left in libraries after mid-run closes; `cbz_` extraction folders stay in the install's temp folder until the next launch sweeps them (by design).

## Findings

Repro paths are libraries I built in the scratchpad; the script that produced each is named. Status is Open for all (Futaba flags, does not fix). "Pre-existing" means the same behaviour is in v1.9.7 (checked against `82f6f0e`).

### Blocker

None.

### Major

**F-01 (Major, pre-existing): Convert offers an original for permanent delete while some of its pages are in no CBZ.**
The CBZ is validated against what 7-Zip extracted, not against the archive's own listing, so anything 7-Zip drops on the way is invisible to the check. Clean first-run repro (`build-m1.mjs`, `lib-m1`, 5 archives, all five appear under "Converted this session", summary says `Done. 5 of 5 file(s) converted successfully.`):
- `CrcBad.zip` (4 pages, one with a bad CRC): CBZ has 3, page 002 lost; log shows `WARNING: 1 page(s) had CRC errors and were skipped`, the delete modal does not.
- `Trunc.zip` (zip cut at 60 percent): CBZ has 3 of 5; same warning-in-log-only.
- `Dup.zip` (`001.jpg` twice, different content): CBZ has 2 of 3 pages; **no warning at all**.
- `Case.zip` (`A.jpg` and `a.jpg`): CBZ has 2 of 3 pages; **no warning at all**.
- (`Mix.zip`, page-like `003.jfif`, `004.jxl` and `notes.txt` dropped silently, see F-13.)
Independent oracle: `MISSING 1/4`, `1/3`, `1/3` of the offered originals' pages in any CBZ. Deleting `CrcBad.zip` through the modal really removed it (permanent, no Recycle Bin, ruling 16). Why it is not a Blocker: same in v1.9.7, needs an unusual or damaged archive, not a break of the ordinary flow. Why it matters: Sergei's ruling 23 says "An original must never be offered for delete unless its own pages are in a CBZ validated against it"; that is false for these four inputs. Jane: decide whether ruling 23 was scoped to the twin-name case; if not, this is Sergei's call, not mine.

**F-02 (Major, pre-existing): a password-protected archive hangs Convert and Resize with no message.**
7-Zip waits for a password on its stdin. Repro (`t-enc.mjs`): a folder with `A-Enc.zip` (encrypted) and `B-after.zip`: the run sits at `[1/2] A-Enc.zip  Extracting archive…` indefinitely (12 s observed, 300 s in an earlier pass), one `7z.exe` alive, tabs disabled. Cancel recovers in about 260 ms but stops the whole run (B-after never converted); a re-run hangs at the same file until it is moved away. Resize does the same on an encrypted CBZ (`t-resize2.mjs`, `B-Enc.cbz`); Cancel there kept the file that had finished. The app never says "password".

**F-03 (Major, new feature gap): a folder whose images all have unstorable names is skipped as "no images found", so the Names panel never appears for it.**
`Scan Ext-Folders` counts images by extension; `page 001.jpg ` (trailing space) has extension `.jpg ` and is not counted. Repro (`t-many.mjs`, first version): `Big.cbz\` with 600 pages named `page NNN.jpg ` and nothing else: scan log says `Skipping Big.cbz — no images found`; no row, no fix. With one normal `000-cover.jpg` added the same folder works (600 rows, fixed in 4.7 s). The message is false, and this is exactly the ripper pattern the fix flow exists for.

### Minor

1. **Old copy still has `(s)` and `1 <plural>` next to the new correct copy.** All pre-existing lines, so within ruling 15's "leave existing lines alone", but they sit in the flows the brief asked about. Seen live: `Done: X.cbz  (2 file(s))`, `Found 17 folder(s) with archive extension names`, `Found 3 file(s) to convert.`, `Stopped. 12 file(s) converted before cancel.` (ruling says unchanged), `Done. N of M file(s) converted successfully.` (unchanged by ruling), `Found 4 file(s) that may be collection/split-archive leftovers` (touched this release), `Ready — 7 file(s) to replace`, `Found 13 CBZ file(s). Processing with 4 worker(s)`, `1 / 3 page(s) exceed 4500px`, `OK — 1 page(s) resized`, `Resize cancelled … 1 file(s) finished`, `Done — 1 file(s) replaced`, panel titles `14 folder(s) converted`, `1 folder(s) to rename (strip extension)`, `2 image(s)`; and true "1 plural" cases: `(1 images)` (`Packing loose images → NestDeep.cbz  (1 images)`), `1 CBZs in Deep\`, `All 1 pages within 4500px — skipped`, resize modal `[1/1 pages — 0 B saved]`. About 45 `(s)` strings in `src/` and `renderer/app.js` (grep). New strings written this release are clean.
2. **Raw 7-Zip output leaks into user-facing text (pre-existing).** Conversion Summary line for a corrupt file is the whole `Command failed: …\7z.exe x -o<temp>\cbz_… -y -- <file> ERROR: … Is not archive` dump with internal temp paths (the friendly failure block follows it). Resize: log `ERROR: ERROR: \\?\C:\…\Corrupt.cbz : Cannot open the file as archive` (doubled), and the Replace modal's Errors list shows the raw reason (`ERROR: \\?\Corrupt.cbz Cannot open the file as archive`) instead of the friendly message used in the end-of-run block.
3. **Judy's Fix line is only true for two of the four Resize collision kinds** (section 4): `7z rn` cannot rename one of two identical entries, nor one of `A.jpg` / `a.jpg`. GUI untested.
4. **Resize skips, without a collision message, a CBZ whose colliding entries leave a small page behind.** `CollideCase.cbz` (`A.jpg` big first, `a.jpg` small) logged `All 1 pages within 4500px — skipped`; the collision messages only appear when the surviving page is oversized (second library, all four messages verified). No data risk (nothing replaced), but the CBZ is silently left unresized.
5. **Resize does not preserve entry order (ruling 26 item 4: evidence recorded).** 7-Zip writes entries sorted. `Order.cbz` `[10.jpg, 2.jpg, 1.jpg, z.txt, a.txt]` became `[1.jpg, 10.jpg, 2.jpg, a.txt, z.txt]`; `Big1.cbz` moved the `Empty\` folder entry after `ComicInfo.xml`; `Dots.cbz`, `OddNames.cbz` also reordered; `Deep`, `Plain`, `TrailSpace` unchanged. Names, sizes and CRCs are exact. A reader that follows archive order (not name order) will show a resized CBZ's pages in another order.
6. **A hierarchical file that fails on a nested archive leaves the CBZs it already wrote, and blames the outer file.** `NestBad2.zip` (good `a-ok.zip`, corrupt `z-bad.zip`) leaves `NestBad2\a-ok.cbz`; `One.zip` / `Two.zip` (nested archives with no pages) leave `One\a-ok.cbz` / `Two\a-ok.cbz`. Ruling 26 item 1 is fixed for the existing-CBZ conflict case (`NestBundle.zip`: `Removed 1 CBZ this run had written…`, nothing left) but not for these. The leftovers are valid CBZs and the outer file is not offered, so no loss. For the corrupt nested file the failure block says `"NestBad2.zip" — Open ERROR: Cannot open the file as [zip] archive` and `the file itself may be corrupt`: the outer file is fine, the inner one is not.
7. **Placeholder wording is user-visible:** `Removed 1 CBZ this run had written for this file.` (`converter.js:1204`, comment `PLACEHOLDER wording — Judy to check (ruling 26)`).
8. **Needs-review dialog re-asks about files just converted, and its Convert button calls a valid state a failure (pre-existing).** After a successful run, `Bundle.zip`, `Split.zip`-style bundles and any archive whose CBZ name differs (`Chapter 01.zip` to `Review - #001.cbz`, `Vol 05.zip`) appear in the delete modal AND again as "Manual Review Required … may not have been converted yet". On a re-run, Convert on such a file logs `SKIP (exists)` for every output and then shows `Conversion failed — see log for details.` because the outcome is `allSkipped`.
9. **Ext-folder and archive sharing a name:** `Dirclash.zip` next to a folder `Dirclash.cbz\` fails with `EPERM: operation not permitted, rename 'Dirclash.cbz.tmp' -> 'Dirclash.cbz'`, a misleading `WARN: Existing Dirclash.cbz is unreadable — re-converting…`, the advice `the file itself may be corrupt`, and leaves `Dirclash.cbz.tmp` (a full 3-page CBZ) in the library. Original not offered.
10. **Unwrap preview promises the same folder twice:** `Foo .cbz` and `Foo..cbz` (also `Foo.cbz` + `Foo .cbz`) both preview as `Foo\`; the second is skipped at apply with `preview target "Foo" was created after scan — rerun to re-resolve` (it was created by the first item of the same run).
11. **Tooltips missing on pre-existing controls (all new controls have one):** Convert-to-CBZ rows (checkbox and Open Folder), Rename row Open Folder, Converted Folders rows (Open Folder, Delete Folder), and every `Done:` / `Warning:` log line's Open Folder (36 in one run). The tooltip text also differs: `Open this folder in Explorer` (failure block) vs `Open this folder in Explorer.` (panels, Renamed lines). The existing Converted Folders Open Folder buttons are 23 px tall (new-panel buttons are at least 24).
12. **Replace mode on a file with a trailing space removes its image extension:** `page 1.jpg ` becomes `page 1.jpg_`, so the CBZ carries it as a non-page file. Per Judy's spec; the default Remove keeps the extension. Worth a tooltip or a hint.
13. **Fix All modal and panel edges:** a row that can no longer be renamed is still counted in `Rename N Items?` and listed as `→ "?"`; after `File or folder not found…` the row's Fix stays disabled (spec says it re-enables; the locked-file failure does re-enable); Escape and a click on the dimmed overlay do not close the modal; the folder headers in the Names panel are very dim (crude contrast measure 2.55:1 default, 2.2 cyberpunk, 3.5 comics, 3.9 manga; the `from` names about 4.1 to 4.4:1) — Jane / Judy to eyeball the screenshots.
14. **Non-listed file types are dropped when converting (design limit):** `Mix.zip` (`001.jpg`, `002.jpg`, `003.jfif`, `004.jxl`, `notes.txt`, `ComicInfo.xml`) gives a CBZ with `001.jpg`, `002.jpg`, `ComicInfo.xml`; the `.jfif` and `.jxl` pages and the note are gone and the original is offered. Resize, by contrast, carries such files over.
15. **Small pre-existing oddities seen along the way:** Delete Empty Folders logs `Deleted 3 empty folder(s).` twice; the Converted Folders title keeps its old count after a single Delete Folder (says 14 with 13 rows left); every Convert-to-CBZ row shows `⚠ target exists — will use alternate name` because the source folder itself occupies `X.cbz`, and a folder `Foo .cbz` gets `Foo  (1).cbz` (two spaces). Re-running Convert over an already converted 180 MB archive took 2.9 s against 1.35 s for the first conversion (indicative only, machine load not measured).

## Not exercised (explicit)

- The NSIS installer and the installed app (never run, by instruction); the packaged build tested is `--dir` output, so `app-update.yml` and the auto-update path were not exercised.
- Replace across drives (`replaceWithResized` sibling-copy fallback): the scratchpad is on one volume. I tried a lock that makes the plain rename fail, but `fsyncFile` (needs write access) fails first, so the fallback itself never ran; the failure kept the original untouched and the other file replaced normally.
- The 7-Zip File Manager (GUI) rename (section 4).
- `name-invalid-char` rows end to end (cannot exist on NTFS here).
- `7zip-not-found` paths (7-Zip is bundled) and ImageMagick missing.
- Multi-volume / split RAR (`.part1.rar`), `.rar` with a password beyond the hang above, network drives (`Y:`), very large libraries.
- Sort ambiguity modal (no equal-specificity target folders built); drag-and-drop folder onto the panel; keyboard-only use beyond Escape.
- Visual sign-off: screenshots were captured headless; per ProcessRules § Verification Discipline a human eyeball on the new panels and modal is still required.
- Other environment note (pre-existing, unrelated to this diff): `node_modules/electron/dist` has no Electron binary on this machine, so `npm start` is not runnable here; `npm run pack` works because electron-builder uses its own cached Electron. `CHANGELOG.md` has no v1.10.0 entry yet (Sully's step).

## Regression verification against fix commit

Everything above was run against the packed build of `d46269d` (asar compared to HEAD). Items re-verified as fixed in this build: N1 (deep path converts), N2 (folders named `Thumbs.db` / `desktop.ini`), N3 (device names, `con_`), F1 (300+ character folder path, no crash), F4 (`Cancelled — N folders …`), F5 (a `cbz_` folder in `%TEMP%` survives startup), rulings 21 to 26 as described in section 2 and 7 except where F-01 and Minor 6 say otherwise.

Pattern alerts: 4 (dispositions below are Futaba's proposals; Jane confirms)

- **PA-1 — Checks trust what the tool read or extracted, not the source's own listing.** Resize and folder-pack now compare against the original's listing; Convert (F-01) still compares against the extraction, and Unwrap (deletes the bundle CBZ to the Recycle Bin after `7z x -y`, same overwrite behaviour, not tested here) probably does too. Proposed disposition: fix, in a later version, using the exact-copy check Resize already has; Sergei decides scope and timing.
- **PA-2 — Old copy survives next to new correct copy in every touched flow** (`(s)`, `1 images`, raw command dumps in summary lines, friendly block below a raw one; Minor 1 and 2). Proposed: defer to one wording sweep owned by Judy, then close.
- **PA-3 — Tooltip gaps on pre-existing controls persist while every new control ships with one** (Minor 11). Proposed: defer to a scheduled tooltip audit (ProcessRules allows it).
- **PA-4 — 7-Zip is spawned with an open stdin, so any prompt hangs the run** (password: F-02; the same class can bite any future 7-Zip prompt). Proposed: fix, small and mechanical, in Convert / Resize / Unwrap / folder-pack spawns; not needed for this release.

**Verdict:** GO

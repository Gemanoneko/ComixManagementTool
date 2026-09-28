# ComixManagementTool v1.9.8 — Sergei's rulings and the fix-flow spec (2026-09-28)

Branch `wip/audit-fixes`. Already built and committed there: `e2e4768` (C1, C2, M1–M5), `61a9236` (carry-over, hierarchical collision, nested failure, case F, `.resize.tmp` startup sweep), `15e8c21` (Convert validates existing outputs, single-instance lock, Judy's wording, folder-pack keeps every file + end-of-run error summary).

## Rulings (Sergei, direct, this session)
1. Startup sweep of leftover `.resize.tmp` files: **yes** (done in `61a9236`).
2. A failed nested archive fails the outer bundle; an existing output counts as done only if it validates: **yes** (done).
3. Normal Convert validates existing outputs: **yes** (done). Single-instance lock: **yes** (done).
4. Judy's 5 wording fixes: **yes** (done).
5. Folder-pack packs **every** file into the CBZ (option a), validated against the source folder (done).
6. Folder-pack: a failure never stops the run; errors are shown clearly at the end of the run with how to fix them (done, as a text summary).
7. **Interactive fix flow ships in v1.9.8.** "Offer me the options to fix and then the app will do the fixes, when I choose the way to go." Spec below.
8. After the last bad name in a folder is fixed: **pack that folder automatically.**
9. Fix All: **confirm modal first** ("Rename N items?").
10. Default mode: **Remove**.
11. Fixes rename the user's real files on disk (implied by 7; Jane's reading, not contradicted).
12. Empty top-level subfolder in a folder being packed: **keep failing the folder** (current behaviour).
13. `Thumbs.db` and `desktop.ini`: **leave them out of CBZs.** They must not count as missing in the validation either.
14. Fix all five of Ender's findings from the `15e8c21` report in v1.9.8:
    - F1: folder-pack crashes on a path longer than ~260 characters (`spawn` cwd → unhandled `read ENOTCONN`).
    - F2: the needs-review dialog can offer to delete an archive that failed validation this run, without saying so.
    - F3: the pre-existing list trusts a quick open check for originals not validated this run (after Cancel; archives with no images or an error).
    - F4: cancelling folder-pack shows "Done: …" instead of "Conversion cancelled."
    - F5: a dev copy and the installed app can run at once and share `%TEMP%`, so one's startup sweep can hit the other's temp files.
15. Convert and Resize get the same grouped end-of-run error block as folder-pack: **yes** (Judy to spec).
16. Kept from earlier: the permanent delete of originals in the Convert flow stays (no Recycle Bin).

## Interactive fix flow — Judy's spec (folder-pack only)

Builds on the end-of-run log summary, which stays as it is. Adds two panels in `#tab-fix`, right after `#extDeletionPanel`, using the existing `<section class="panel fix-preview-panel hidden">` scaffold (same shape as `extConvertPanel` / `extRenamePanel` / `extDeletionPanel`). They are filled from `result.failures` in the `folderpack:convertComplete` payload.

- `#packFixNamesPanel` — Group A (rename)
- `#packFixRetryPanel` — Group B (retry)

### Cause → group
| Cause code(s) | Group | Fix offered | Mode toggle |
|---|---|---|---|
| `name-trailing-space`, `name-trailing-dot`, `name-invalid-char` | A — Rename | Remove, or Replace with `_` | Yes (default **Remove**) |
| `name-reserved` | A — Rename | Append `_` | No — one button |
| `size-mismatch`, `missing-entry`, `missing-folder`, `content-mismatch`, `unexpected-entry`, `unexpected-folder`, `invalid-cbz`, `7zip-read-error`, `7zip-error`, `unsupported-entry`, `empty-subfolder`, `error` | B — Retry | Retry (pack the folder again) | n/a |
| `7zip-not-found` | none | log only, no panel row | n/a |

### Names panel — one row per bad name (not per folder)
Rows are grouped under a folder-path header, like `renderExtConvert`. Each row, left to right:
- old rel path (`fix-group-from` styling) → new name (`fix-group-to`, updates live with the toggle; folders get a trailing `\`)
- conflict badge when needed — reuse `renderExtConvert`'s existing text and class
- mode toggle ( Remove | Replace with _ ) — not shown for `name-reserved`
- Open Folder (existing `fix-row-open`)
- **Fix** (`btn btn-fix-apply`) — renames this one entry

**New-name computation**, all in one pass:
1. Invalid characters `[<>:"|?*\x00-\x1f]`, matched globally: Remove strips every match; Replace swaps each for `_`.
2. A trailing run of spaces or periods at the end of the result: Remove strips the whole run; Replace collapses it to a single `_`.
3. Reserved-name check on the result (case-insensitive, ignoring anything after the first `.`; CON/PRN/AUX/NUL/COM1-9/LPT1-9): append `_`, whatever the mode.
4. If the result is empty, use `_`.

**Conflict:** if a sibling with the new name exists, use `Name (1)`, `Name (2)` … — before the extension for a file, at the end for a folder. This is the same algorithm as `resolveTargetFolder` / `resolveTargetCbz`. Recompute it at rename time, not only at preview time.

### Retry panel — one row per folder
`folderRel` · message (the same `describeFailure` string as the log) · `Fix: …` line · Open Folder · **Retry**.

A folder that has both rename-fixable and unfixable records never moves to the Retry panel. It stays in the log summary only.

### Bulk actions
- **Fix All** (Names toolbar) applies each row's current mode, after a confirm modal. The modal reuses the `modal-overlay` / `modal-box` scaffold:
  - title `Rename {N} Item{s}?` — singular or plural correctly
  - description `Renaming can't be undone through this app. Review the list, then confirm.`
  - a read-only old → new list
  - **Cancel** and **Rename All** (`btn-danger`)
- **Retry All** (Retry toolbar): no confirm, because packing never touches the source. Run it sequentially and reuse `fixProgressWrap` / `fixProgressFill`.

### IPC
- **Retry:** reuse `folderpack:convert` with `selectedFolderPaths` set to just the retried folders (the `convertGroups` from the scan).
- **Rename:** new channel, e.g. `folderpack:renameEntry` `{ folderPath, relPath, cause, char, mode }` → `{ success, newRelPath, conflict, error }`. Sanitize, resolve conflicts and rename in the main process.
- **Preview values:** either compute them once when `failures` arrives, or add a preview variant. Ender's call.

### After a fix
- **Rename succeeds:** the row disappears. Log: `Renamed: "<old rel>" → "<new rel>"` (success, with Open Folder). If it was the folder's last fixable row and the folder has no unfixable record, **pack that folder again automatically** (ruling 8).
- **Rename fails:** the row stays, with an inline error, and Fix re-enables. Log: `Failed to rename "<old rel>": <error>`.
- **Retry or auto-repack succeeds:** the row disappears, and the output goes to `extConverted` / `renderExtDeletion` exactly as a first-time success would.
- **Retry fails again:** the row updates in place with the new message. The log gets a fresh failure-summary entry; the log is append-only.

### Labels and tooltips
| Control | Label | Tooltip |
|---|---|---|
| Toggle, trailing space | Remove / Replace with _ | Delete the trailing space. / Replace the trailing space with an underscore. |
| Toggle, trailing period | Remove / Replace with _ | Delete the trailing period. / Replace the trailing period with an underscore. |
| Toggle, invalid character | Remove / Replace with _ | Delete the character Windows can't store. / Replace the character Windows can't store with an underscore. |
| Per-row Fix | Fix | Rename to "`<newName>`". |
| Names toolbar | Fix All | Rename every listed file and folder to its shown new name. |
| Modal cancel | Cancel | Close without renaming anything. |
| Modal confirm | Rename All | Rename every listed item. |
| Per-row Retry | Retry | Pack "`<folderRel>`" again. |
| Retry toolbar | Retry All | Pack every listed folder again. |
| Open Folder | Open Folder | Open this folder in Explorer. |

### Hit areas
Controls are at least 24×24 CSS px (32–40 is comfortable) and must not overlap sibling rows at any width. Measure this once it's built.

## Convert and Resize end-of-run error block — Judy's spec (ruling 15)

**Plurals:** every new string uses a correct singular or plural (`1 file` / `2 files`), never `(s)`. This is Judy's own earlier ruling. Leave existing unchanged lines alone.

### Shared shape (the same as folder-pack's `logFailureSummary`)
```
<n> <noun> failed to <verb>:              ← 'header'
  "<rel path>" — <message>                ← 'error', with an Open Folder button
    Fix: <fix>                            ← 'info'
```
- The indents are 2 and 4 spaces.
- The block appears once, on a normal (not cancelled) completion only. It is text only: no fix panel.
- **Open Folder for these rows:** label `Open Folder`, action `shell:openFolder` (highlights the file), tooltip **"Show this file in Explorer"**. Reuse the string at `renderer/app.js:1193`.
- `appendLog` needs a mode flag for `shell:openFolder`, defaulting to today's `shell:openPath`, so folder-pack's calls stay unchanged.

### Convert (`src/converter.js`)
- **Order:** `logSummary` (unchanged), then the new `logConvertFailureSummary`, then the completion line. The two first steps run only when not aborted.
- **Completion line with failures:** `Done. <c> of <n> files converted, <f> failed (see failures above).`
- **The other completion lines are unchanged:** `Stopped. …` and `… converted successfully.`
- **Entry identity:** `path.relative(rootFolder, file)`.

| Cause | Message | Fix |
|---|---|---|
| 7-Zip missing | `7-Zip is missing from this install — it can't extract this file.` | Reinstall the app, then convert again. |
| ImageMagick missing | `ImageMagick isn't installed — it's needed to convert PDF pages.` | Install ImageMagick 7 from imagemagick.org, then convert this file again. |
| Unsafe path inside archive | `"<file>" has a page name that points outside its own folder — treated as unsafe, not converted.` | Get a clean copy of this file, then convert it again. |
| Fatal 7-Zip error | first non-empty line of 7-Zip's stderr, verbatim | Convert it again — if it keeps failing, the file itself may be corrupt. |
| Fatal ImageMagick error | first non-empty line of ImageMagick's stderr, verbatim | Convert it again — if it keeps failing, check that the PDF isn't password-protected or corrupt. |
| No images found | `No pages were found inside this file.` | Open it and check it actually holds image pages. |
| CBZ integrity test failed | `"<name>.cbz" failed an integrity check.` | Convert it again. |
| CBZ unreadable after packing | `Couldn't read back "<name>.cbz" to check it.` | Convert it again — if it keeps failing, close anything that has the file open. |
| CBZ has zero pages | `"<name>.cbz" was created with no pages in it.` | Convert it again. |
| Page-count mismatch | `"<name>.cbz" should hold <expected> pages but has <found>.` (singular or plural) | Convert it again. |
| Existing output doesn't validate | `An existing "<name>.cbz" doesn't match this file — <inner reason>.` | Move or delete the existing "<name>.cbz" yourself, then convert this file again. |
| Nested archive not validated | `"<nested name>" inside this file didn't convert or validate.` + ` (+N more)` | Convert this file again — if it keeps failing, convert "<nested name>" on its own to see the detailed error. |
| Pages lost (hierarchical) | `<lost> of <total> pages aren't in a validated CBZ.` (singular or plural) | Convert this file again. |

### Resize (`src/resizer.js`)
- **Placement:** after the worker pool settles and after the existing aborted early return, so a cancelled run is unchanged. Then comes the existing `Ready — …` line, then the new `logResizeFailureSummary`.
- **Remove** the old line: `<n> file(s) failed — see above for details.`
- **Entry identity:** `path.relative(folder, cbzPath)`.
- The existing `validateCbz` / `compareEntries` reasons are used **verbatim** as the message. Every one of them gets the Fix `Resize it again.`:
  - `Archive integrity test failed (corrupt ZIP or CRC error)`
  - `Cannot list archive contents`
  - `CBZ contains no image files`
  - `Image count mismatch: …`
  - `Missing from resized copy: …`
  - `Size differs in resized copy: …`
  - `Content differs in resized copy: …`
  - `Unexpected in resized copy: …`
  - `Folder missing from resized copy: …`
  - `Unexpected folder in resized copy: …`
- **Failure reading the original CBZ** for the comparison:
  - message `"<name>.cbz" can't be read to check the resize against it.`
  - Fix `Check that the file isn't corrupt or in use, then resize it again.`
  - This replaces today's raw exec error.
- **Any other fatal 7-Zip or ImageMagick error:**
  - message: the first non-empty stderr line, not the whole `err.stderr || err.message`
  - Fix `Resize it again — if it keeps failing, check that the file isn't corrupt, in use, or password-protected.`
- **Renderer `resize:complete`,** in the branch where no resize was needed: `Done — <k> files already within 4 500 px<, <e> failed (see failures above)>.` Drop the old `, N error(s)` clause.

## Folder-pack wording verdicts (Judy)
1. **The four name-cause messages get the `${more}` suffix** (" (+N more)"), like the other causes.
2. **Size message:** if `formatBytes` would print the two sizes identically, show exact bytes instead: `"<f>" is <a> bytes in the folder but <b> bytes in the CBZ.<more>`
3. **`Failed: <folderRel>` stays unindented.** It pairs with `Converting: …`.
4. **Placeholders:**
   - **Empty subfolder:** gets its own case. Keep the message; Fix `Add at least one file to "<subfolder>" — or delete the empty subfolder — then pack the folder again.`
   - **Link or special file:** gets its own case. Keep the message; Fix `Replace "<name>" with a regular file or folder, then pack the folder again.`
   - **Keep verbatim, in the default bucket:** `Unexpected in CBZ` / `Unexpected folder in CBZ` / `Content differs in CBZ`, `Invalid CBZ — <reason>`, and the first line of 7-Zip's error.
   - **Keep:** `U+XXXX` for control characters.
5. **Cancelled folder-pack:** `Cancelled — <c> folders converted before cancel<, <f> failed (see failures above)>.` Use correct singular and plural.
   - Note: today `folderpack:convert` always sends `aborted: false`, because `applyConvertFolders` breaks out of the loop and returns normally. The flag must actually reflect `signal.aborted`.

## More rulings (Sergei, later the same session)
17. **Version: this release ships as v1.10.0**, not v1.9.8. It adds features (the fix panels), and the tool's rules say features get a minor bump. The file name of this doc keeps "v1.9.8" for history.
18. **Fix panels for Convert and Resize: later, not in this release.** Text-only `Fix:` lines ship now. The interactive flow for Convert and Resize goes on the list for a future version.
19. **Resize size messages carry the actual sizes.** They follow Judy's folder-pack size pattern, with "original" and "resized copy" in place of "folder" and "CBZ":
    - `"<f>" is <a> in the original but <b> in the resized copy.<more>`
    - When `formatBytes` would print the two sizes the same, use exact bytes: `… is <a> bytes in the original but <b> bytes in the resized copy.<more>`
    - Judy checks this wording in her review of the build.
20. **Fix Ender's N1–N3 in v1.10.0:**
    - **N1:** Convert fails on archives whose internal paths push 7-Zip's working folder past about 258 characters.
    - **N2:** a *folder* named `Thumbs.db` or `desktop.ini` makes the pack fail.
    - **N3:** a folder with a device name (e.g. `con`) may target a bad CBZ name.

## Judy's red-team review of `5242abf`: changes to make

These are text and UX fixes only. Every item not listed here stays as it is.

1. **Rename errors.** Make these three changes:
   - `Folder is not in the last scan.` → `Folder is not in the last scan. Scan Ext-Folders again, then retry.`
   - `File or folder not found.` → `File or folder not found. It may have moved — scan Ext-Folders again.`
   - `"<name>" already exists.` → `"<name>" already exists. Click Fix again to use the next available name.`

   Keep these as they are: `Path is outside the folder.`, `Name has nothing to fix.`, `A pack is running — try again when it finishes.`
2. **Raw file-system rename error** (`folder-packer.js` ~719): `"<name>" couldn't be renamed (<err.code or 'unknown error'>). Close anything using it, then try Fix again.` Show no full paths.
3. **`.pack-fix-name`:** `white-space: pre-wrap; overflow-wrap: anywhere;` instead of `pre`. Long paths then wrap in the rows and in the Fix All modal, and trailing spaces stay visible.
4. **Fatal 7-Zip message** (`firstErrorLine()` in `converter.js` and the duplicated logic in `resizer.js`): when the output has a bare `ERROR: <path>` line, show the line **after** it. Fall back to the first non-empty line only when there's no such line. One shared helper for both files.
5. **`.log-open-btn`:** add `min-height: 24px`. It's about 18.8px tall today in every theme, and it's the Open Folder button on every error-block line.
6. **Show the full relative new name,** not just the leaf name:
   - Row: `to.textContent = "<newRelPath>" + (dir ? "\\" : "")`, in quotes.
   - Fix All modal: `"<folderRel>\<relPath>" → "<folderRel>\<newRelPath>"`.

   This way a rename inside a subfolder doesn't look like a move.

**Confirmed as built:** `con.txt` → `con_.txt`; quoted names; `folder\entry` paths in the log; the 24px minimum height inside the panels; panel titles; the Convert catch-all.

## More rulings (Sergei, after `a53a19b`)
21. **Fix all three of Ender's findings from the `a53a19b` report in v1.10.0:**
    - **Unwrap:** a bundle named after a device (`con.cbz`) must not create a device-named folder. Apply the `_` rule in `unwrapper.js`.
    - **Re-runs after a `_` rename:** once `nul.zip` has become `nul_.cbz`, a re-run must still match the two, so the original is offered as pre-existing, not sent to needs-review.
    - **Resize on very deep archives:** test the ImageMagick path limit, and fix it if it fails.

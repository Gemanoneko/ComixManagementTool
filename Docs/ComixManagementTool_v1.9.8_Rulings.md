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

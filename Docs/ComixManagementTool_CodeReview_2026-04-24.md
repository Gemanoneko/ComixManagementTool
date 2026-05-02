# ComixManagementTool — Code Review (2026-04-24)

**Reviewer:** Senua (Code Reviewer)
**Version reviewed:** 1.9.2 (HEAD: `97a1a64505883d4d3f28b86a8d15b172efbcf0e3`)
**Prior review:** None (first review)
**Verdict:** **RELEASE CLEAR**

## Summary

The codebase is in solid shape for a first full review. Electron wiring is correct (contextIsolation on, nodeIntegration off, preload used). All external-process calls go through `execFile` with argv arrays — there is no shell string concatenation, so the app is not vulnerable to classic command injection. The delete-after-validate flow is architecturally correct: originals are only ever added to the deletion list after a CBZ has been successfully packed and passed `validateCbz`, or after a prior-run CBZ has been confirmed openable via `canOpenCbz`. No Critical findings. A handful of Major improvements are recommended before the app accumulates more surface area.

## Critical Findings

None.

## Major Findings

### M1. Abort-mid-pack can leave an unvalidated CBZ that future runs treat as valid

**Files:** `src/converter.js` (lines 867–896, `processFile`); `src/converter.js` (line 100, `canOpenCbz`); `src/resizer.js` (lines 317–338)

**Issue:** If the user cancels (or the process crashes) after `packToCbz` completes but before `validateCbz` returns, the output `.cbz` exists on disk. On the next run, `processFile` reaches the skip-if-exists branch (line 873) and calls `canOpenCbz`. `canOpenCbz` only verifies that 7-Zip can *list* the archive and that at least one image entry exists — it does NOT cross-check image count against the source. The abort-time CBZ is therefore treated as a successfully converted file and the source archive is silently eligible for deletion on the subsequent pass via `findOrphanedOriginals` (because `canOpenCbz` passes, line 959).

**Why it matters:** This is the one real data-loss scenario in the codebase. A user who hits Cancel during the pack step of a multi-group archive, then re-runs, could delete originals that were never fully validated.

**Suggested fix:** On abort inside the signal handler (or in a `try/catch` around `packToCbz`), delete the partial output *before* rethrowing `AbortError`. Mirror the existing pattern in `packToCbz`'s error branch (line 728). Alternatively, write a `.cbz.tmp` file and rename only after validation passes — this makes the state self-describing and resistant to crash as well as cancel.

### M2. 7-Zip arg arrays missing `--` separator on list/extract/test calls

**Files:** `src/converter.js` (lines 106, `canOpenCbz`; line 215 et al.); `src/validator.js` (lines 34, 42); `src/unwrapper.js` (lines 37, 200); `src/resizer.js` (line 252); `src/folder-packer.js` (line 311)

**Issue:** `extractArchive` at `src/converter.js:127` correctly passes `'--'` before the source filename to prevent a file whose name starts with `-` from being parsed as a 7-Zip switch. Every other 7-Zip invocation omits this guard:

- `['l', '-slt', cbzPath]` — list
- `['t', cbzPath]` — integrity test
- `['e', longPath(cbzPath), ...]` — resize extract
- `['x', cbzPath, '-o…', '-y']` — unwrap extract
- `['a', '-tzip', '-mx=0', outputPath, '@listPath']` — pack (outputPath is user-influenced via `baseName`)

**Why it matters:** Not a shell-injection vector (no shell is involved), but a 7-Zip *switch* injection one. A user who points the tool at a folder containing a file literally named `-ao.cbz` or `-ssc-.cbz` would cause 7-Zip to interpret the filename as switches, producing wrong behaviour (including potential overwrite-without-prompt). Archive filenames starting with `-` do exist in the wild.

**Suggested fix:** Add `'--'` immediately before the first filename argument in every 7-Zip call. The pack call (`'a'`) and the list-file form (`@listPath`) need the separator placed carefully; for `@listPath`, the leading `@` already disambiguates, but for the output path, add `--` before it. Write a tiny helper `sevenZipArgs(op, ...paths)` that always injects `--` to prevent this regressing.

### M3. Preload exposes an un-allowlisted IPC invoke gateway

**File:** `preload.js` (lines 3–10)

**Issue:** `contextBridge.exposeInMainWorld('electron', { invoke, on, removeAllListeners })` lets the renderer invoke *any* IPC channel registered on the main process, including `conversion:deleteOriginals` with *any* file list. Main-process handlers do not validate that incoming paths originate from the conversion pipeline — `conversion:deleteOriginals` in `main.js:815` simply loops over the provided array and `fs.promises.unlink`s each entry.

**Why it matters:** In a single-user, non-sandboxed Electron app loading only bundled local files with a strict CSP (`default-src 'self' data:`), the attack surface is minimal — there is no remote origin and no user-supplied HTML. However, the preload is defence-in-depth. Any future regression (a bundled dependency injecting DOM, a bad copy-paste that adds `innerHTML` with attacker-controlled content, a vulnerability in the theme loader) becomes significantly more dangerous with a universal invoke gateway.

**Suggested fix:** Replace the generic `invoke` with a per-channel API (`convertStart`, `convertCancel`, `deleteOriginals`, etc.) wired explicitly, and drop the generic `on`/`removeAllListeners` in favour of named subscribe functions. As a smaller step, at least maintain an allowlist Set of valid channels in the preload and reject unknown ones with a thrown error.

### M4. No `will-navigate` / `setWindowOpenHandler` hardening on the BrowserWindow

**File:** `main.js` (lines 56–73, `createWindow`)

**Issue:** The main window has no navigation or window-open handlers. A renderer-side bug that injects an `<a href="…">` or triggers `window.open(…)` would navigate the app window to arbitrary content, still running in the main renderer context. Combined with M3, this becomes a broader issue than it looks.

**Why it matters:** Current code does not trigger this — all `.innerHTML = ''` assignments are resets or static strings (I verified all 26 sites). But this is standard Electron hardening and cheap to add.

**Suggested fix:**
```js
mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
```
Add `shell.openExternal(url)` wrappers for any future external-link buttons.

### M5. ImageMagick version sort is lexicographic, not semver

**File:** `src/tools.js` (lines 63–72, `findImageMagick`)

**Issue:** `fs.readdirSync(base).filter(...).sort().reverse()` picks the "highest" ImageMagick folder by string comparison. `ImageMagick-7.1.11-Q16-HDRI` sorts *before* `ImageMagick-7.1.2-Q16-HDRI` because `'1' < '2'`, so the *older* install wins when two or more are present.

**Why it matters:** Mostly harmless (most users have one install), but as ImageMagick hits 7.2.x alongside older 7.1.x builds it will silently pick the wrong one. Hard to debug later.

**Suggested fix:** Extract `(\d+)\.(\d+)\.(\d+)` from the directory name and sort numerically, or use `localeCompare(b, undefined, { numeric: true })`.

## Minor Findings

### m1. `cleanupOrphanedTempDirs` can delete other applications' ImageMagick scratch files

**File:** `main.js` (lines 11–24). The startup sweep removes anything in `os.tmpdir()` starting with `magick-`. If the user has another ImageMagick-using tool running in parallel, we'll yank its in-flight scratch files. Narrow the filter to a prefix we own (e.g., `cmt_magick-`) once we start writing such files ourselves, or leave `magick-*` untouched and only manage our own `cbz_*` prefix.

### m2. Renderer's `conversion:convertSingle` trusts a vague success signal

**File:** `renderer/app.js:950–957`, calling into `src/converter.js:1113` (`convertSingleFile`). The renderer deletes the original as soon as `result.success` is truthy, but `processFile` returns `success: outputs.length > 0` — which is correct today, yet fragile if future refactors change the shape. Add an explicit `validated: true` flag to the return object and check that in the renderer before deleting.

### m3. Validator keys off extensions, not magic bytes

**File:** `src/validator.js:49–54`. The file comment in `CLAUDE.md` describes a magic-byte check but the implementation filters entries by extension and relies on `7z t` for integrity. A zero-byte `foo.jpg` inside the extracted tmpDir would still increment the count and pass CRC (CRC-32 of empty is 0x00000000, valid). The scenario is not reachable in normal operation (7-Zip wouldn't produce empty outputs from a valid source), but the doc–code mismatch is worth fixing either by implementing the actual magic-byte check or by updating the doc to describe the real validation strategy.

### m4. `where` lookup in `tools.js` trusts CWD-first PATH resolution

**File:** `src/tools.js:50, 77`. Windows `where.exe` searches the current directory before PATH. If a user ever ran the app from a folder they didn't own that contained a spoofed `7z.exe`, that binary would execute. Very low-risk because bundled 7-Zip is resolved first, but consider adding `System32` and `System32\WindowsPowerShell\v1.0` to the search explicitly, or drop the `where` fallback in favour of failing with an install message.

### m5. `resolveTargetFolder` called twice in unwrapper between scan and apply

**File:** `src/unwrapper.js:138` (scan) and `:188` (apply). The preview shows `previewTarget` based on the folder state at scan time; at apply time it re-resolves, which can produce a different name if conflicts appeared between the two phases. Either always use the re-resolved path in the log/UI or lock the preview path at scan time and fail apply on conflict. Current behaviour silently diverges.

### m6. `resizer.js` uses non-atomic tmp-dir creation

**File:** `src/resizer.js:232`. `path.join(os.tmpdir(), 'cbz_resize_' + randomBytes(6))` followed by `mkdirSync(…, { recursive: true })` is functionally fine, but the `converter.js` pattern of `fs.mkdtempSync(os.tmpdir() + path.sep + 'cbz_')` is atomic and guaranteed unique. Align on `mkdtempSync` everywhere.

### m7. `autoInstallOnAppQuit = false` but 5-second auto-check runs

**File:** `src/updater.js:17, 58`. The updater auto-checks at startup but does not auto-install on quit; downloaded updates therefore just sit in userData until the user clicks the banner. That's fine, but if `download-update` IPC is invoked and the app is then killed before `install-update`, the downloaded installer lingers. Consider wiring `autoInstallOnAppQuit = true` once silent install is confirmed safe, or document the current behaviour.

### m8. `duplicates.js` computes MD5 for equality only — OK, but label it

**File:** `src/duplicates.js:35–43`. MD5 is fine for non-security equality, but a reader coming from a security-review mindset will flinch. A one-line `// MD5 used for content-equality only, not integrity` comment would pre-empt the question.

### m9. `scanner.js` does not yield between file entries, only between directories

**File:** `src/scanner.js:13`. `await new Promise(r => setImmediate(r))` happens once per directory. Very large flat directories (10k+ files) block the IPC loop for the duration of the `readdirSync`. Unlikely at Sergei's library scale but worth knowing.

### m10. Duplicate `execFilePromise` helper defined in three files

**Files:** `src/converter.js:58`, `src/resizer.js:36`, plus `execFileAsync` variants in `src/validator.js`, `src/unwrapper.js`, `src/folder-packer.js`. Five slightly different wrappers, each handling abort signals differently (the validator and unwrapper ones don't accept a signal at all). Extract a single shared helper in a `src/exec.js` module.

### m11. Hardcoded Y: / I: preset paths in the renderer

**File:** `renderer/index.html:59–76`, 123–131, 205–214, 265–273. Fine for Sergei's personal tool but couples the UI to his drive topology. If the app ever migrates to a different machine, the presets silently point to empty folders. Consider moving them to `settings.json` with a defaults fallback.

### m12. `ArchiveParentDir` computation is a basename, not a full parent path

**File:** `src/converter.js:847`. `path.basename(srcDir)` gives only the immediate parent folder name — used as the "series" context for generic-name resolution. For an archive nested three levels deep (`Y:\Manga\Series\Vol 1\file.zip`), the series is correctly picked up from `"Vol 1"`. OK, but if Sergei ever lays out libraries differently this subtly changes naming.

## Positive Observations

- **Everywhere uses `execFile` with argv arrays.** No `shell: true`, no string concatenation into a command line. This alone eliminates the entire class of shell-injection bugs. Keep this discipline.
- **contextIsolation: true, nodeIntegration: false.** Baseline Electron sandboxing is correct.
- **CSP is present and sensible.** `default-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'` is reasonable; no `unsafe-eval`, no CDN sources.
- **Validate-before-delete is genuinely enforced.** `processFile` deletes the partial CBZ and returns `success: false` on validation failure. `startConversion` only pushes to `converted[]` on `result.success`. `findOrphanedOriginals` only flags a source for deletion if the matching CBZ is actually openable (`canOpenCbz`, line 959). This is the right architecture.
- **Abort handling is uniform.** Every long-running pipeline uses an `AbortController` pattern with child-process `kill()` on abort and an `AbortError` that the outer loops recognise. The pause primitive is implemented carefully as a Promise race against the abort signal — this is better than a lot of production code.
- **CRC-failure recovery in `extractArchive`.** Parsing 7-Zip's exit-code-2 output to distinguish partial-CRC failure from fatal errors, then recovering by dropping the bad pages, is thoughtful. The comment explicitly calls out the `/^error:/i` anchoring requirement — that's a non-obvious bug someone else already paid for; keep the comment.
- **`longPath()` in resizer.js.** Windows MAX_PATH handling via `\\?\` prefix is exactly right and saves real-world breakage on deep comic libraries.
- **PDF page count has a no-external-tool fast path.** Reading the xref/trailer area and scoping to `/Type /Pages` context to avoid false positives from font dicts shows the author has already been bitten by the naive approach. Good.
- **Fast image-dimension reader in `resizer.js`.** Replacing per-file `magick identify` with header-byte parsing for JPEG/PNG/GIF/BMP/WebP is a real perf win.
- **Deepest-first flatten ordering.** Resolving chains correctly requires sorting by depth before applying; the code does this and re-verifies the condition before each apply — defensively correct.
- **Name-normalised orphan detection.** `findOrphanedOriginals` uses `normaliseForMatch` so `(Rip)(DCP)` matches `(Rip) (DCP)` etc. Prevents false "needs-review" hits on benign spacing differences.

## Recommendations

Priority-ordered for Ender's next cycles:

1. **(Major)** Fix M1 — the unvalidated-CBZ-on-abort window. Either delete partial outputs on abort, or adopt a `.cbz.tmp → rename` pattern. This is the only realistic data-loss path.
2. **(Major)** Fix M2 — add `--` separators to every 7-Zip argv. Mechanical change, write a helper.
3. **(Major)** Fix M3 — narrow the preload API to a per-channel allowlist. Before adding any feature that renders remotely fetched content, this should be done.
4. **(Major)** Fix M4 — add the two navigation-blocking lines. One-minute change.
5. **(Major)** Fix M5 — numeric ImageMagick version sort. Tiny, prevents future silent selection bugs.
6. **(Minor)** Consolidate the five `execFile*` helpers into `src/exec.js` (m10) — the current drift is how subtle signal-handling bugs creep in.
7. **(Minor)** Add a `validated: true` flag to `processFile`'s return and gate single-file delete on it (m2).
8. **(Minor)** Address the validator-vs-doc mismatch (m3): either implement the magic-byte check or correct the doc.

Senua stands down. Release is clear.

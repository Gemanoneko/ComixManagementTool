'use strict';
/**
 * folder-packer.js — finds folders whose names have archive extensions
 * (e.g. "Batman - Vol 1.cbz\") and processes them:
 *
 * Category A: folder holds no archives → Convert to CBZ (every file and
 *             folder in it goes into the CBZ(s), not only the pages)
 * Category B: folder contains archives → Rename (strip the extension)
 *
 * Conflict handling: if the target name already exists, append (1), (2)… like Windows.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execFilePromise } = require('./exec');
const { sevenZipArgs, listFileContent } = require('./seven-zip');
const { getSevenZip } = require('./tools');
const { validateCbz, testIntegrity, listEntries, compareEntries } = require('./validator');
const { sizePair } = require('./format');
const { tempRoot } = require('./temp');

const ARCHIVE_FOLDER_EXTS = new Set(['.cbr', '.cbz', '.rar', '.zip']);
const IMAGE_EXTS           = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif']);
const ARCHIVE_FILE_EXTS    = new Set(['.cbr', '.cbz', '.rar', '.zip', '.pdf']);

// ── Helpers ────────────────────────────────────────────────────────────────────

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Find a non-conflicting folder path (strips ext from baseName, then adds (1)…) */
function resolveTargetFolder(parentDir, baseName) {
  const base = path.join(parentDir, baseName);
  if (!fs.existsSync(base)) return base;
  let n = 1;
  while (fs.existsSync(path.join(parentDir, `${baseName} (${n})`))) n++;
  return path.join(parentDir, `${baseName} (${n})`);
}

/** Find a non-conflicting CBZ path. Returns { targetPath, conflict } */
function resolveTargetCbz(parentDir, baseName) {
  const base = path.join(parentDir, `${baseName}.cbz`);
  if (!fs.existsSync(base)) return { targetPath: base, conflict: false };
  let n = 1;
  while (fs.existsSync(path.join(parentDir, `${baseName} (${n}).cbz`))) n++;
  return { targetPath: path.join(parentDir, `${baseName} (${n}).cbz`), conflict: true };
}

/** Shallow-read a directory and split files by type */
function readDirFiles(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return { images: [], xml: [], archives: [], subdirs: [] }; }

  const images   = [];
  const xml      = [];
  const archives = [];
  const subdirs  = [];

  for (const e of entries) {
    if (e.isDirectory()) {
      subdirs.push({ name: e.name, dir: path.join(dir, e.name) });
    } else if (e.isFile()) {
      const ext  = path.extname(e.name).toLowerCase();
      const full = path.join(dir, e.name);
      if (IMAGE_EXTS.has(ext))        images.push(full);
      else if (ext === '.xml')         xml.push(full);
      else if (ARCHIVE_FILE_EXTS.has(ext)) archives.push(full);
    }
  }

  images.sort((a, b) => naturalSort(path.basename(a), path.basename(b)));
  subdirs.sort((a, b) => naturalSort(a.name, b.name));
  return { images, xml, archives, subdirs };
}

/** Recursively check whether a folder contains any archive files */
function folderHasArchives(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return false; }
  for (const e of entries) {
    if (e.isFile() && ARCHIVE_FILE_EXTS.has(path.extname(e.name).toLowerCase())) return true;
    if (e.isDirectory() && folderHasArchives(path.join(dir, e.name))) return true;
  }
  return false;
}

// A name Windows can't use as-is.  NTFS can hold one (created through a
// `\\?\` path, by WSL, or copied from another OS), but ordinary Windows paths
// drop a trailing space or period and map CON/NUL/… to devices — so the name
// can't be packed and read back reliably (extracting such a CBZ on Windows
// renames the entry).  Checked before anything is packed; the interactive
// fix flow (renameEntry) renames the entry on disk.
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\s*\..*)?$/i;
const INVALID_CHAR  = /[<>:"|?*\x00-\x1f]/;   // `/` and `\` can't occur in a directory entry

// Windows' own thumbnail cache and folder-view settings: never packed into a
// CBZ (Sergei's ruling 13) and not counted as missing by the exact-copy check.
// Matched case-insensitively, as files only, at any depth.
const JUNK_FILES = new Set(['thumbs.db', 'desktop.ini']);
const isJunkFile = (name) => JUNK_FILES.has(name.toLowerCase());

function unstorableName(name) {
  const ch = name.match(INVALID_CHAR);
  if (ch) {
    const char = ch[0] < ' ' ? `U+${ch[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` : ch[0];
    return { cause: 'name-invalid-char', char };
  }
  if (name.endsWith(' '))       return { cause: 'name-trailing-space' };
  if (name.endsWith('.'))       return { cause: 'name-trailing-dot' };
  if (RESERVED_NAME.test(name)) return { cause: 'name-reserved' };
  return null;
}

/**
 * Everything under an ext-folder, as paths relative to it:
 *   files    – { rel, size } for every regular file, in walk order
 *              (Thumbs.db / desktop.ini left out — see JUNK_FILES)
 *   dirs     – every folder
 *   problems – failure records (file, cause, detail, isDir) for names Windows
 *              can't use as-is and for entries that are neither a file nor a
 *              folder (links, devices), which can't be carried faithfully
 * Throws if a folder can't be read.
 */
function walkSource(root) {
  const files = [], dirs = [], problems = [];
  (function walk(dir, relDir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relDir ? path.join(relDir, e.name) : e.name;
      if (e.isFile() && isJunkFile(e.name)) continue;
      const bad = unstorableName(e.name);
      if (bad) {
        problems.push({ file: rel, ...bad, isDir: e.isDirectory(), detail: `Name Windows can't store: ${JSON.stringify(rel)}` });
        continue;                                      // nothing under a bad folder name can be packed either
      }
      if (e.isDirectory()) { dirs.push(rel); walk(path.join(dir, e.name), rel); continue; }
      if (e.isFile()) { files.push({ rel, size: fs.lstatSync(path.join(dir, e.name)).size }); continue; }
      problems.push({ file: rel, cause: 'unsupported-entry', detail: `"${rel}" is a link or special file, not a regular file or folder.` });
    }
  })(root, '');
  return { files, dirs, problems };
}

/** A structured folder-pack failure, carrying one or more records. */
class PackFailure extends Error {
  constructor(records) {
    super(records[0].detail);
    this.records = records;
  }
}

/**
 * Pull "WARNING: <message>" + "<file>" pairs out of 7-Zip's stderr — how
 * `7z a` (exit code 1) reports each listed file it could not read (locked by
 * another program, access denied, vanished).  Those files are simply left out
 * of the archive.
 */
function parseSevenZipReadWarnings(stderr) {
  const lines = String(stderr || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^WARNING:\s*(.+)$/);
    if (!m) continue;
    const file = lines[i + 1] || '';               // not trimmed: a leading space is part of the name
    if (file.trim()) { out.push({ file, message: m[1].trim() }); i++; }
  }
  return out;
}

/** Recursively count image files */
function countImages(dir) {
  let n = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) n++;
    else if (e.isDirectory()) n += countImages(path.join(dir, e.name));
  }
  return n;
}

/** Walk rootDir and collect all folders whose names have archive extensions */
async function collectExtFolders(rootDir, signal) {
  const results = [];
  async function walk(dir) {
    if (signal?.aborted) return;
    await new Promise((r) => setImmediate(r));
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (signal?.aborted) return;
      const full = path.join(dir, e.name);
      const ext  = path.extname(e.name).toLowerCase();
      if (ARCHIVE_FOLDER_EXTS.has(ext)) {
        results.push(full);
        // Do NOT recurse into ext-folders — their contents are what we analyze
      } else {
        await walk(full);
      }
    }
  }
  await walk(rootDir);
  return results;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Scan rootDir for folders with archive extension names.
 * Returns { convertGroups, renameGroups }.
 *
 * convertGroups — Category A: no archives inside → pack everything to CBZ
 * renameGroups  — Category B: contains archive files → rename (strip extension)
 */
async function scanExtFolders(rootDir, log, sendProgress, signal) {
  log('Collecting folders with archive extension names…', 'info');

  const allFolders = await collectExtFolders(rootDir, signal);
  if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

  const total = allFolders.length;
  log(`Found ${total} folder(s) with archive extension names — analyzing…`, 'info');

  const convertGroups = [];
  const renameGroups  = [];

  for (let i = 0; i < allFolders.length; i++) {
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    await new Promise((r) => setImmediate(r));
    sendProgress?.(i + 1, total);

    const folderPath = allFolders[i];
    const folderName = path.basename(folderPath);
    const folderExt  = path.extname(folderName).toLowerCase();
    const parentDir  = path.dirname(folderPath);
    const baseName   = path.basename(folderName, folderExt);
    const folderRel  = path.relative(rootDir, folderPath);

    if (folderHasArchives(folderPath)) {
      // Category B — rename
      const targetPath = resolveTargetFolder(parentDir, baseName);
      const targetRel  = path.relative(rootDir, targetPath);
      renameGroups.push({
        folderPath,
        folderRel,
        folderName,
        baseName,
        parentDir,
        targetPath,
        targetRel,
        conflict: path.basename(targetPath) !== baseName,
      });
    } else {
      const imageCount = countImages(folderPath);
      if (imageCount === 0) {
        log(`  Skipping ${folderRel} — no images found`, 'skip');
        continue;
      }

      // Category A — convert to CBZ
      const { targetPath, conflict } = resolveTargetCbz(parentDir, baseName);
      const targetRel  = path.relative(rootDir, targetPath);
      const { subdirs } = readDirFiles(folderPath);

      convertGroups.push({
        folderPath,
        folderRel,
        folderName,
        baseName,
        parentDir,
        targetPath,
        targetRel,
        imageCount,
        hasSubdirs: subdirs.length > 0,
        conflict,
      });
    }
  }

  const totalFound = convertGroups.length + renameGroups.length;
  log(
    totalFound > 0
      ? `Found ${convertGroups.length} folder(s) to convert, ${renameGroups.length} folder(s) to rename.`
      : 'No ext-named folders found.',
    totalFound > 0 ? 'success' : 'info'
  );

  return { convertGroups, renameGroups };
}

/**
 * Convert all selected Category A groups: pack every file of each folder into
 * CBZ(s), then offer deletion of the source folder.
 *
 * A folder that fails is logged and skipped; the run carries on with the rest.
 * Every failure is kept as a structured record and all of them are listed
 * together at the end of the run (logFailureSummary).  A failed folder is
 * never offered for deletion, is left exactly as it was, and has no CBZ left
 * behind — so the next Scan Ext-Folders finds it again.
 *
 * Returns { converted, failed, convertedItems, failures, aborted }
 *   convertedItems – [{ folderPath, folderRel, outputPaths }]
 *   failures       – [{ folder, folderPath, message, fix, fixGroup,
 *                       records: [{ folder, file, cause, detail, isDir?, char?, … }] }]
 *                    message / fix: the end-of-run summary text (describeFailure);
 *                    fixGroup: which fix-flow panel offers a fix (see fixGroupOf)
 *   aborted        – true when Cancel stopped the run (folders not reached are
 *                    neither converted nor failed)
 */
async function applyConvertFolders(rootDir, groups, log, sendProgress, signal) {
  const total          = groups.length;
  let   converted      = 0;
  const convertedItems = [];
  const failures       = [];
  const fail = (group, records) => {
    const recs = records.map((r) => ({ folder: group.folderRel, file: null, ...r }));
    failures.push({ folder: group.folderRel, folderPath: group.folderPath, ...describeFailure(recs), fixGroup: fixGroupOf(recs), records: recs });
  };

  const sz = getSevenZip();
  if (!sz) {
    log('7-Zip not found — cannot pack folders.', 'error');
    for (const g of groups) fail(g, [{ cause: '7zip-not-found', detail: '7-Zip not found — cannot pack folders.' }]);
    logFailureSummary(failures, log);
    return { converted: 0, failed: failures.length, convertedItems: [], failures, aborted: false };
  }

  sendProgress?.(0, total);

  for (let i = 0; i < groups.length; i++) {
    if (signal?.aborted) break;

    const group = groups[i];
    const { folderPath, folderRel, baseName, parentDir } = group;

    log(`Converting: ${folderRel}`, 'info');

    try {
      const outputPaths = await packFolder(sz, folderPath, baseName, parentDir, log, signal);
      converted++;
      convertedItems.push({ folderPath, folderRel, outputPaths });
    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) break;
      log(`Failed: ${folderRel}`, 'error');
      fail(group, err instanceof PackFailure ? err.records : [{ cause: 'error', detail: err.message }]);
    }

    sendProgress?.(i + 1, total);
  }

  logFailureSummary(failures, log);
  return { converted, failed: failures.length, convertedItems, failures, aborted: !!signal?.aborted };
}

/**
 * Plan the CBZ(s) for one folder from its walkSource listing:
 * - no subfolders: one CBZ with every file;
 * - subfolders: each subfolder → one CBZ holding its WHOLE tree (every file,
 *   nested folders kept, empty ones included), plus one CBZ named after the
 *   folder for the files at its root.
 * A subfolder with no files anywhere in it has no CBZ to go in, so it fails
 * the folder rather than being dropped.
 * Returns { jobs: [{ name, srcDir, prefix, files: [{rel,size}], dirs }], problems }
 * with every path in a job relative to its srcDir.
 */
function planJobs(folderPath, baseName, src) {
  const top  = (rel) => !rel.includes(path.sep);
  const jobs = [], problems = [];
  const rootFiles = src.files.filter((f) => top(f.rel));
  const topDirs   = src.dirs.filter(top).sort(naturalSort);

  if (topDirs.length === 0) {
    jobs.push({ name: baseName, srcDir: folderPath, prefix: '', files: rootFiles, dirs: [] });
    return { jobs, problems };
  }
  for (const d of topDirs) {
    const pre   = d + path.sep;
    const files = src.files.filter((f) => f.rel.startsWith(pre)).map((f) => ({ rel: f.rel.slice(pre.length), size: f.size }));
    if (files.length === 0) {
      problems.push({ file: d, cause: 'empty-subfolder', detail: `Subfolder "${d}" has no files, so there is no CBZ to keep it in.` });
      continue;
    }
    const dirs = src.dirs.filter((x) => x.startsWith(pre)).map((x) => x.slice(pre.length));
    jobs.push({ name: d, srcDir: path.join(folderPath, d), prefix: pre, files, dirs });
  }
  if (rootFiles.length > 0) jobs.push({ name: baseName, srcDir: folderPath, prefix: '', files: rootFiles, dirs: [] });
  return { jobs, problems };
}

/**
 * Pack a single ext-named folder into one or more CBZ files (see planJobs).
 *
 * Every file goes in, not only pages and XML: the folder is offered for
 * deletion afterwards, so anything left out (.jxl, .txt, empty folders, …)
 * would be lost.  Before anything is packed, a name Windows can't use as-is
 * fails the folder.  Each CBZ is then checked against the folder itself —
 * the same exact-copy check Resize uses: same relative paths, same folders,
 * same size for every file — plus integrity and, when it has pages, the page
 * count.  Any difference fails the folder.
 *
 * Throws PackFailure (structured records) on failure, after removing every
 * CBZ this call created; the folder itself is never written to (the 7-Zip
 * listfile lives in the temp folder).  Returns the created CBZ paths.
 */
async function packFolder(sz, folderPath, baseName, parentDir, log, signal) {
  const src = walkSource(folderPath);
  if (src.problems.length > 0) throw new PackFailure(src.problems);
  const { jobs, problems } = planJobs(folderPath, baseName, src);
  if (problems.length > 0) throw new PackFailure(problems);

  if (jobs.length === 0) {
    log(`  ${baseName}: no files to pack`, 'skip');
    return [];
  }

  const outputPaths = [];
  const doneLines   = [];      // logged only once the whole folder has validated
  try {
    for (const job of jobs) {
      if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

      const { targetPath, conflict } = resolveTargetCbz(parentDir, job.name);
      if (conflict) {
        log(`  Warning: "${job.name}.cbz" already exists — saving as "${path.basename(targetPath)}"`, 'warn', parentDir);
      }
      outputPaths.push(targetPath);   // removed again below if anything fails

      const records = await packJob(sz, job, targetPath, signal, folderPath);
      if (records.length > 0) throw new PackFailure(records);
      doneLines.push(`  Done: ${path.basename(targetPath)}  (${job.files.length} file(s))`);
    }
  } catch (err) {
    for (const p of outputPaths) { try { fs.unlinkSync(p); } catch {} }
    throw err;
  }
  for (const line of doneLines) log(line, 'success', parentDir);
  return outputPaths;
}

// On Windows, prefix `\\?\` so 7-Zip opens paths longer than MAX_PATH.
function longPath(p) {
  if (process.platform !== 'win32' || !path.isAbsolute(p)) return p;
  if (p.startsWith('\\\\')) return p;
  return '\\\\?\\' + path.normalize(p);
}

/**
 * Pack one planned job to `targetPath` and check it.  Returns failure
 * records (file paths relative to the ext-folder; empty when the CBZ is good).
 *
 * 7-Zip gets only absolute `\\?\` paths and never runs in the folder being
 * packed.  It used to run with that folder as its working directory, and
 * Windows refuses a working directory of 259+ characters: the spawn failed,
 * and at 260+ it crashed the app (unhandled "read ENOTCONN").
 *   • a subfolder's CBZ: "<subfolder>\*" — 7-Zip stores every entry
 *     relative to the subfolder, recursing, empty folders included;
 *   • the root CBZ (or a folder with no subfolders): a listfile of the root
 *     files' absolute paths — 7-Zip stores each by its bare name.
 * Thumbs.db and desktop.ini are excluded at any depth (`-xr!`).
 */
async function packJob(sz, job, targetPath, signal, folderPath) {
  const rel        = (p) => job.prefix + p;       // job path → path in the ext-folder
  const imageCount = job.files.filter((f) => IMAGE_EXTS.has(path.extname(f.rel).toLowerCase())).length;
  const target     = longPath(targetPath);
  const switches   = ['-tzip', '-mx=0', '-sccUTF-8', ...[...JUNK_FILES].map((n) => `-xr!${n}`)];

  // The listfile lives in this install's temp folder (cbz_ prefix: the
  // startup sweep removes it after a crash) — never in the folder being
  // packed, where it would overwrite a file of the same name.
  let listPath = null;
  let args;
  if (job.prefix) {
    args = sevenZipArgs('a', switches, target, longPath(job.srcDir) + '\\*');
  } else {
    listPath = path.join(tempRoot(), `cbz_pack_${crypto.randomBytes(6).toString('hex')}.lst`);
    fs.writeFileSync(listPath, listFileContent(job.files.map((f) => longPath(path.join(job.srcDir, f.rel)))), 'utf8');
    // `@listPath` is a 7-Zip listfile switch — the helper detects it and
    // emits an argv shape with no `--` and the listfile as the trailing
    // positional (per 7-Zip's grammar, `--` stops @listfile parsing).
    args = sevenZipArgs('a', [...switches, `@${listPath}`], target);
  }
  try {
    // -sccUTF-8: file names in 7-Zip's warnings arrive intact.
    await execFilePromise(sz, args, signal, { cwd: tempRoot(), maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (err.name === 'AbortError' || signal?.aborted) throw err;
    // Exit code 1 = warnings: 7-Zip left out the files it could not read.
    // It names them by absolute path; report them relative to the ext-folder.
    const unread = err.code === 1 ? parseSevenZipReadWarnings(err.stderr) : [];
    if (unread.length > 0) {
      const toRel = (p) => {
        const abs = p.replace(/^\\\\\?\\/, '');
        if (!path.isAbsolute(abs)) return rel(abs);
        const r = path.relative(folderPath, abs);
        return r && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r) ? r : abs;
      };
      return unread.map((u) => ({ file: toRel(u.file), cause: '7zip-read-error', detail: u.message }));
    }
    if (err.code !== 1) {
      const line = String(err.stderr || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      return [{ file: null, cause: '7zip-error', detail: line || err.message }];
    }
    // Other warnings only — the checks below decide.
  } finally {
    if (listPath) { try { fs.unlinkSync(listPath); } catch {} }
  }

  // Exact-copy check against the folder: every file with its size, every folder.
  let outEntries;
  try {
    outEntries = await listEntries(target, signal);
  } catch (err) {
    if (err.name === 'AbortError' || signal?.aborted) throw err;
    return [{ file: null, cause: 'invalid-cbz', detail: 'Invalid CBZ — Cannot list archive contents' }];
  }
  const expected = [
    ...job.files.map((f) => ({ path: f.rel, isDir: false, size: f.size, crc: null })),
    ...job.dirs.map((d) => ({ path: d, isDir: true, size: null, crc: null })),
  ];
  const cmp = compareEntries(expected, outEntries, [], 'CBZ');
  if (!cmp.valid) {
    const CAUSE = { missing: 'missing-entry', size: 'size-mismatch', content: 'content-mismatch',
      extra: 'unexpected-entry', 'missing-folder': 'missing-folder', 'extra-folder': 'unexpected-folder' };
    const LABEL = { missing: 'Missing from CBZ', size: 'Size differs in CBZ', content: 'Content differs in CBZ',
      extra: 'Unexpected in CBZ', 'missing-folder': 'Folder missing from CBZ', 'extra-folder': 'Unexpected folder in CBZ' };
    return cmp.problems.map((p) => ({
      file: rel(p.path), cause: CAUSE[p.cause], detail: `${LABEL[p.cause]}: ${rel(p.path)}`,
      ...(p.cause === 'size' ? { sourceSize: p.sourceSize, cbzSize: p.outputSize } : {}),
    }));
  }

  // Integrity, and the page count when the CBZ holds pages.  (A CBZ made from
  // a subfolder of non-page files legitimately has none.)
  const v = imageCount > 0 ? await validateCbz(target, imageCount, signal) : await testIntegrity(target, signal);
  if (!v.valid) return [{ file: null, cause: 'invalid-cbz', detail: `Invalid CBZ — ${v.reason}` }];
  return [];
}

// ── End-of-run failure summary ─────────────────────────────────────────────────
// Judy's spec (2026-09-28): one block in the log, just before the renderer's
// "Done: …" line; one entry per failed folder, with its Open Folder button, and
// a "Fix:" line.  When a folder has several problems, the most actionable one
// is shown: a bad name, then a file 7-Zip couldn't read, then a missing file,
// a size difference, a missing folder, then anything else.

const PRIORITY = ['name-trailing-space', 'name-trailing-dot', 'name-reserved', 'name-invalid-char',
  '7zip-read-error', 'missing-entry', 'size-mismatch', 'missing-folder'];

function describeFailure(records) {
  const rank = (r) => { const i = PRIORITY.indexOf(r.cause); return i < 0 ? PRIORITY.length : i; };
  const first = records.reduce((best, r) => (rank(r) < rank(best) ? r : best), records[0]);
  const sameCause = records.filter((r) => r.cause === first.cause).length;
  const more = sameCause > 1 ? ` (+${sameCause - 1} more)` : '';
  const f = first.file;
  switch (first.cause) {
    case 'name-trailing-space': return { message: `"${f}" ends with a space — Windows can't store that.${more}`,
      fix: 'Rename it to remove the trailing space, then pack the folder again.' };
    case 'name-trailing-dot':   return { message: `"${f}" ends with a period — Windows can't store that.${more}`,
      fix: 'Rename it to remove the trailing period, then pack the folder again.' };
    case 'name-reserved':       return { message: `"${f}" is a reserved Windows name (like CON or NUL) — Windows can't store that as a filename.${more}`,
      fix: 'Rename it to something other than a reserved device name, then pack the folder again.' };
    case 'name-invalid-char':   return { message: `"${f}" contains a character Windows can't store (${first.char}).${more}`,
      fix: `Remove ${first.char} from the name, then pack the folder again.` };
    case 'size-mismatch': {
      // Two sizes that differ by a few bytes can format identically ("1.5 MB");
      // then the exact byte counts are shown instead (Judy's verdict 2).
      const [a, b] = sizePair(first.sourceSize, first.cbzSize);
      return { message: `"${f}" is ${a} in the folder but ${b} in the CBZ.${more}`, fix: 'Pack the folder again.' };
    }
    case 'empty-subfolder':     return { message: first.detail,
      fix: `Add at least one file to "${f}" — or delete the empty subfolder — then pack the folder again.` };
    case 'unsupported-entry':   return { message: first.detail,
      fix: `Replace "${f}" with a regular file or folder, then pack the folder again.` };
    case 'missing-entry':       return { message: `"${f}" is in the folder but missing from the CBZ.${more}`,
      fix: 'Pack the folder again.' };
    case 'missing-folder':      return { message: `Subfolder "${f}" is in the folder but missing from the CBZ.${more}`,
      fix: 'Pack the folder again.' };
    case '7zip-read-error':     return { message: `7-Zip couldn't read "${f}" — ${first.detail.replace(/[.\s]+$/, '')}.`,
      fix: 'Close any program that has this file open, then pack the folder again.' };
    default:                    return { message: first.detail,
      fix: "Pack the folder again — if it keeps failing, check the folder's file and folder names." };
  }
}

function logFailureSummary(failures, log) {
  if (failures.length === 0) return;
  const n = failures.length;
  log(`${n} ${n === 1 ? 'folder' : 'folders'} failed to pack:`, 'header');
  for (const fl of failures) {
    log(`  "${fl.folder}" — ${fl.message}`, 'error', fl.folderPath, 'Open this folder in Explorer');
    log(`    Fix: ${fl.fix}`, 'info');
  }
}

// ── Interactive fix flow (Sergei's rulings 7–11, Judy's spec) ──────────────────

const NAME_CAUSES = new Set(['name-trailing-space', 'name-trailing-dot', 'name-invalid-char', 'name-reserved']);

/**
 * Which fix-flow panel offers a fix for a failed folder:
 *   'names' – every record is a bad name → rename them (Names panel)
 *   'retry' – no bad names → pack it again (Retry panel)
 *   null    – 7-Zip is missing, or bad names mixed with other problems:
 *             the end-of-run log summary only
 */
function fixGroupOf(records) {
  if (records.some((r) => r.cause === '7zip-not-found')) return null;
  const names = records.filter((r) => NAME_CAUSES.has(r.cause)).length;
  if (names === records.length) return 'names';
  return names === 0 ? 'retry' : null;
}

/**
 * The new name for a bad name, in one pass (Judy's spec):
 *   1. every invalid character: 'remove' strips it, 'replace' swaps it for `_`;
 *   2. a trailing run of spaces/periods: 'remove' strips it, 'replace'
 *      collapses it to one `_`;
 *   3. a reserved device name (CON, NUL, COM1 … — the part before the first
 *      `.`, case-insensitive): `_` is appended to that part, whatever the
 *      mode, so the extension survives ("con.txt" → "con_.txt");
 *   4. nothing left → `_`.
 */
function sanitizeName(name, mode = 'remove') {
  const replace = mode === 'replace';
  let n = name.replace(/[<>:"|?*\x00-\x1f]/g, replace ? '_' : '');
  n = n.replace(/[ .]+$/, replace ? '_' : '');
  const dot  = n.indexOf('.');
  const base = dot < 0 ? n : n.slice(0, dot);
  const stem = base.replace(/\s+$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) n = stem + '_' + n.slice(stem.length);
  return n || '_';
}

/**
 * `name` in `dir`, or "Name (1)", "Name (2)" … when that is taken — before
 * the extension for a file, at the end for a folder (as resolveTargetCbz /
 * resolveTargetFolder do).  `taken` (lower-cased names) holds names already
 * claimed by earlier renames in the same preview batch.
 */
function resolveNameConflict(dir, name, isDir, taken = new Set()) {
  const busy = (n) => taken.has(n.toLowerCase()) || fs.existsSync(path.join(dir, n));
  if (!busy(name)) return { name, conflict: false };
  const ext  = isDir ? '' : path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let i = 1;
  while (busy(`${stem} (${i})${ext}`)) i++;
  return { name: `${stem} (${i})${ext}`, conflict: true };
}

/**
 * Check a rename request from the renderer (main process side):
 *   • folderPath must be one of the folders of the last Scan Ext-Folders;
 *   • relPath must resolve to something strictly inside it that exists;
 *   • its name must actually need fixing.
 * Returns { ok: true, oldPath, dir, name, isDir } or { ok: false, error }.
 */
function checkRenameRequest(scannedFolders, folderPath, relPath) {
  if (typeof folderPath !== 'string' || !scannedFolders.some((f) => f === folderPath)) {
    return { ok: false, error: 'Folder is not in the last scan.' };
  }
  if (typeof relPath !== 'string' || !relPath || path.isAbsolute(relPath)) {
    return { ok: false, error: 'Path is outside the folder.' };
  }
  const oldPath = path.join(folderPath, relPath);
  const back = path.relative(folderPath, oldPath);
  if (!back || back === '..' || back.startsWith('..' + path.sep) || path.isAbsolute(back) || back !== relPath) {
    return { ok: false, error: 'Path is outside the folder.' };
  }
  let st;
  try { st = fs.lstatSync(oldPath); } catch { return { ok: false, error: 'File or folder not found.' }; }
  const name = path.basename(oldPath);
  if (!unstorableName(name)) return { ok: false, error: 'Name has nothing to fix.' };
  return { ok: true, oldPath, dir: path.dirname(oldPath), name, isDir: st.isDirectory() };
}

/**
 * New names for a list of rename rows, as they would come out if renamed in
 * this order: each row's name is checked against the disk and against the
 * names earlier rows in the same folder would take.  Renames nothing.
 * items: [{ folderPath, relPath, mode }] →
 *   [{ ok, newName, newRelPath, conflict } | { ok: false, error }]
 */
function previewRenames(scannedFolders, items) {
  const taken = new Map();                 // dir (lower) → Set of names claimed by earlier rows
  return (Array.isArray(items) ? items : []).map((it) => {
    const c = checkRenameRequest(scannedFolders, it && it.folderPath, it && it.relPath);
    if (!c.ok) return c;
    const key = c.dir.toLowerCase();
    if (!taken.has(key)) taken.set(key, new Set());
    const { name, conflict } = resolveNameConflict(c.dir, sanitizeName(c.name, it.mode), c.isDir, taken.get(key));
    taken.get(key).add(name.toLowerCase());
    return { ok: true, newName: name, newRelPath: path.join(path.dirname(it.relPath), name).replace(/^\.[\\/]/, ''), conflict, isDir: c.isDir };
  });
}

/**
 * Rename one bad name on disk (the user's real file or folder).  The request
 * is re-checked here and the conflict is worked out again now, against the
 * disk as it is, not as it was at preview time.
 * req: { folderPath, relPath, mode } → { success, newRelPath, newName, conflict, error }
 */
function renameEntry(scannedFolders, req) {
  const c = checkRenameRequest(scannedFolders, req && req.folderPath, req && req.relPath);
  if (!c.ok) return { success: false, error: c.error };
  const mode = req.mode === 'replace' ? 'replace' : 'remove';
  const { name, conflict } = resolveNameConflict(c.dir, sanitizeName(c.name, mode), c.isDir);
  const newPath = path.join(c.dir, name);
  const back = path.relative(req.folderPath, newPath);
  if (!back || back === '..' || back.startsWith('..' + path.sep) || path.isAbsolute(back)) {
    return { success: false, error: 'Path is outside the folder.' };
  }
  try {
    if (fs.existsSync(newPath)) return { success: false, error: `"${name}" already exists.` };
    fs.renameSync(c.oldPath, newPath);
  } catch (err) {
    return { success: false, error: err.message };
  }
  return { success: true, newRelPath: back, newName: name, conflict };
}

/**
 * Rename all Category B folders: strip the archive extension from each folder name.
 * Renames happen immediately, no undo.
 * Returns { renamed, failed }.
 */
function applyRenameFolders(rootDir, groups, log) {
  let renamed = 0;
  let failed  = 0;

  for (const group of groups) {
    const { folderPath, folderRel, baseName, parentDir } = group;
    const targetPath = resolveTargetFolder(parentDir, baseName);
    const targetRel  = path.relative(rootDir, targetPath);
    const conflict   = path.basename(targetPath) !== baseName;

    if (conflict) {
      log(`  Note: "${baseName}" already exists — renaming to "${path.basename(targetPath)}"`, 'warn');
    }

    try {
      fs.renameSync(folderPath, targetPath);
      log(`Renamed: ${folderRel}  →  ${targetRel}\\`, 'success', targetPath);
      renamed++;
    } catch (err) {
      log(`  Failed to rename "${folderRel}": ${err.message}`, 'error');
      failed++;
    }
  }

  return { renamed, failed };
}

module.exports = {
  scanExtFolders, applyConvertFolders, applyRenameFolders,
  previewRenames, renameEntry, sanitizeName, resolveNameConflict,
};

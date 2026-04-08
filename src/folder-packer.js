'use strict';
/**
 * folder-packer.js — finds folders whose names have archive extensions
 * (e.g. "Batman - Vol 1.cbz\") and processes them:
 *
 * Category A: folder contains only images/XML → Convert to CBZ
 * Category B: folder contains archives         → Rename (strip the extension)
 *
 * Conflict handling: if the target name already exists, append (1), (2)… like Windows.
 */

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { getSevenZip } = require('./tools');

const ARCHIVE_FOLDER_EXTS = new Set(['.cbr', '.cbz', '.rar', '.zip']);
const IMAGE_EXTS           = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif']);
const ARCHIVE_FILE_EXTS    = new Set(['.cbr', '.cbz', '.rar', '.zip', '.pdf']);

// ── Helpers ────────────────────────────────────────────────────────────────────

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else     resolve({ stdout, stderr });
    });
  });
}

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
 * convertGroups — Category A: only images/XML inside → pack to CBZ
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
 * Convert all selected Category A groups: pack images+XML into CBZ(s), then
 * offer deletion of the source folder.
 * Returns { converted, failed, convertedItems }
 * where convertedItems is [{ folderPath, folderRel, outputPaths }].
 */
async function applyConvertFolders(rootDir, groups, log, sendProgress, signal) {
  const sz = getSevenZip();
  if (!sz) {
    log('7-Zip not found — cannot pack folders.', 'error');
    return { converted: 0, failed: groups.length, convertedItems: [] };
  }

  const total          = groups.length;
  let   converted      = 0;
  let   failed         = 0;
  const convertedItems = [];

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
      log(`  Failed: ${err.message}`, 'error');
      failed++;
    }

    sendProgress?.(i + 1, total);
  }

  return { converted, failed, convertedItems };
}

/**
 * Pack a single ext-named folder into one or more CBZ files.
 * - If folder has no subdirs: one CBZ containing all images + XML
 * - If folder has subdirs: each subdir → one CBZ; loose images at root → one more CBZ
 * Returns array of created CBZ paths.
 */
async function packFolder(sz, folderPath, baseName, parentDir, log, signal) {
  const { images: looseImages, xml: looseXml, subdirs } = readDirFiles(folderPath);

  const packJobs = []; // { name, srcDir, basenames }

  if (subdirs.length === 0) {
    // Flat folder
    const files = [...looseImages, ...looseXml];
    if (files.length > 0) {
      packJobs.push({ name: baseName, srcDir: folderPath, basenames: files.map((f) => path.basename(f)) });
    }
  } else {
    // Multi-CBZ: one per subdir + one for loose images at root
    for (const sub of subdirs) {
      const { images: subImages, xml: subXml } = readDirFiles(sub.dir);
      const files = [...subImages, ...subXml];
      if (files.length > 0) {
        packJobs.push({ name: sub.name, srcDir: sub.dir, basenames: files.map((f) => path.basename(f)) });
      }
    }
    if (looseImages.length > 0) {
      const files = [...looseImages, ...looseXml];
      packJobs.push({ name: baseName, srcDir: folderPath, basenames: files.map((f) => path.basename(f)) });
    }
  }

  if (packJobs.length === 0) {
    log(`  ${baseName}: no files to pack`, 'skip');
    return [];
  }

  const outputPaths = [];

  for (const job of packJobs) {
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

    const { targetPath, conflict } = resolveTargetCbz(parentDir, job.name);

    if (conflict) {
      log(`  Warning: "${job.name}.cbz" already exists — saving as "${path.basename(targetPath)}"`, 'warn', parentDir);
    }

    const listPath = path.join(job.srcDir, '.cbzpack.lst');
    fs.writeFileSync(listPath, job.basenames.join('\n'), 'utf8');
    try {
      await execFileAsync(sz, ['a', '-tzip', '-mx=0', targetPath, `@${listPath}`], { cwd: job.srcDir });
      log(`  Done: ${path.basename(targetPath)}  (${job.basenames.length} file(s))`, 'success', parentDir);
      outputPaths.push(targetPath);
    } catch (err) {
      try { fs.unlinkSync(targetPath); } catch {}
      throw err;
    } finally {
      try { fs.unlinkSync(listPath); } catch {}
    }
  }

  return outputPaths;
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

module.exports = { scanExtFolders, applyConvertFolders, applyRenameFolders };

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Normalisation ───────────────────────────────────────────────────────────

/**
 * Normalise a filename or folder name for word-prefix matching:
 *   - strip parenthetical content  (2022), (Digital), (DC Comics)
 *   - strip from # onwards          #001, #5
 *   - strip leading "The"
 *   - lowercase, collapse separators to spaces, drop non-alphanumeric
 */
function normalise(name) {
  return name
    .replace(/\([^)]*\)/g, ' ')        // (…) → space
    .replace(/#.*/g, ' ')              // #001 … → space
    .replace(/^the\s+/i, '')           // leading "The "
    .toLowerCase()
    .replace(/[-–—_.,!?'"]/g, ' ')     // separators → space
    .replace(/[^a-z0-9\s]/g, '')       // drop everything else
    .replace(/\s+/g, ' ')             // collapse spaces
    .trim();
}

// ─── Folder scanning ─────────────────────────────────────────────────────────

/**
 * Return all immediate subdirectories of dir that have NO subdirectories
 * themselves (i.e. leaf folders where individual issues are stored).
 */
function getLeafFolders(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => {
      try {
        const sub = fs.readdirSync(path.join(dir, e.name), { withFileTypes: true });
        return !sub.some((se) => se.isDirectory());
      } catch { return false; }
    })
    .map((e) => path.join(dir, e.name));
}

// ─── Matching ────────────────────────────────────────────────────────────────

/**
 * Find the best-matching leaf folders for a CBZ file.
 *
 * Matching rule: the normalised folder name must be a word-prefix of the
 * normalised filename.  Among all matches, only keep the most specific ones
 * (longest word-prefix).
 *
 * Returns:
 *   []   → no match found, skip
 *   [x]  → exactly one best match, move automatically
 *   [x,y,…] → multiple equally-specific matches, ask the user
 */
function findMatches(filePath, leafFolders) {
  const filename  = path.basename(filePath, path.extname(filePath));
  const fileWords = normalise(filename).split(' ').filter(Boolean);

  const candidates = leafFolders
    .map((folder) => {
      const folderWords = normalise(path.basename(folder)).split(' ').filter(Boolean);
      if (folderWords.length === 0) return null;
      const isPrefix = folderWords.every((word, i) => fileWords[i] === word);
      return isPrefix ? { folder, len: folderWords.length } : null;
    })
    .filter(Boolean);

  if (candidates.length === 0) return [];

  // Keep only the most specific (longest) match(es)
  const maxLen = Math.max(...candidates.map((c) => c.len));
  return candidates.filter((c) => c.len === maxLen).map((c) => c.folder);
}

// ─── File move (cross-device safe) ──────────────────────────────────────────

function moveFile(src, dst) {
  try {
    fs.renameSync(src, dst);            // fast path: same device
  } catch (err) {
    if (err.code === 'EXDEV') {         // cross-device (different drives)
      fs.copyFileSync(src, dst);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

// ─── Main pipeline ───────────────────────────────────────────────────────────

/**
 * Sort .cbz files from sourceFolder into matching leaf folders under targetFolder.
 *
 * @param {{ sourceFolder: string, targetFolder: string }} options
 * @param {(msg: string, type: string) => void} log
 * @param {(filePath: string, matches: string[]) => Promise<string|null>} onAmbiguous
 *        Called when multiple equally-specific folders match.
 *        Resolve with a folder path to move there, or null to skip.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ moved: number, skipped: number, manual: number }>}
 */
async function startSort(options, log, onAmbiguous, signal) {
  const { sourceFolder, targetFolder } = options;

  // Collect .cbz files at the TOP level of source only (no recursion)
  let files;
  try {
    files = fs.readdirSync(sourceFolder, { withFileTypes: true })
      .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.cbz')
      .map((e) => path.join(sourceFolder, e.name));
  } catch (err) {
    log(`ERROR reading source folder — ${err.message}`, 'error');
    return { moved: 0, skipped: 0, manual: 0 };
  }

  if (files.length === 0) {
    log('No .cbz files found in source folder.', 'info');
    return { moved: 0, skipped: 0, manual: 0 };
  }

  const leafFolders = getLeafFolders(targetFolder);

  log(`Scanning: ${sourceFolder}`, 'header');
  log(`Found ${files.length} .cbz file(s).  Target has ${leafFolders.length} leaf folder(s).\n`, 'info');

  let moved = 0, skipped = 0, manual = 0;

  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) break;

    const file = files[i];
    const name = path.basename(file);
    log(`[${i + 1}/${files.length}] ${name}`, 'header');

    const matches = findMatches(file, leafFolders);

    if (matches.length === 0) {
      log('  No matching folder — skipped', 'skip');
      skipped++;
      continue;
    }

    let dest;
    if (matches.length === 1) {
      dest = matches[0];
    } else {
      // Multiple equally-specific matches → ask the user
      const choice = await onAmbiguous(file, matches);
      if (!choice) {
        log('  Skipped by user', 'skip');
        manual++;
        continue;
      }
      dest = choice;
    }

    const destFile = path.join(dest, name);
    if (fs.existsSync(destFile)) {
      log(`  SKIP: already exists in ${path.basename(dest)}`, 'skip');
      skipped++;
      continue;
    }

    try {
      moveFile(file, destFile);
      log(`  → ${path.basename(dest)}`, 'success');
      moved++;
    } catch (err) {
      log(`  ERROR moving file — ${err.message}`, 'error');
      skipped++;
    }
  }

  return { moved, skipped, manual };
}

module.exports = { startSort };

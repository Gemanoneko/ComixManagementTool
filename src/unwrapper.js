'use strict';
/**
 * unwrapper.js — finds CBZ files that contain other archives inside them
 * (GetComics-style bundles) and extracts them into a named folder.
 *
 * Trigger:  CBZ contains at least one entry with an archive extension.
 * Skip:     CBZ contains only images/non-archive files.
 * Conflict: target folder already exists → append (1), (2) … like Windows.
 */

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { getSevenZip } = require('./tools');

const ARCHIVE_ENTRY_EXTS = new Set(['.cbr', '.cbz', '.rar', '.zip']);

// ── Helpers ────────────────────────────────────────────────────────────────────

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else     resolve({ stdout, stderr });
    });
  });
}

/**
 * Use `7z l -slt` to list entries inside a CBZ.
 * Returns { hasArchives, archiveCount, totalEntries } or null on error.
 */
async function peekCbz(cbzPath) {
  const sz = getSevenZip();
  if (!sz) return null;
  try {
    const { stdout } = await execFileAsync(sz, ['l', '-slt', cbzPath]);
    const lines = stdout.split(/\r?\n/);
    let totalEntries = 0;
    let archiveCount = 0;
    let currentPath  = null;
    let currentIsDir = false;

    for (const line of lines) {
      if (line.startsWith('Path = ')) {
        currentPath  = line.slice(7).trim();
        currentIsDir = false;  // reset for this entry
      } else if (line.startsWith('Folder = ')) {
        currentIsDir = line.slice(9).trim() === '+';
      } else if (line === '' && currentPath) {
        // Blank line = end of entry block — evaluate it now
        if (
          currentPath &&
          !currentIsDir &&
          !/^[A-Za-z]:[\\\/]/.test(currentPath) &&  // skip archive's own header line
          !currentPath.startsWith('\\\\')
        ) {
          const ext = path.extname(currentPath).toLowerCase();
          if (ext) totalEntries++;
          if (ARCHIVE_ENTRY_EXTS.has(ext)) archiveCount++;
        }
        currentPath  = null;
        currentIsDir = false;
      }
    }
    return { hasArchives: archiveCount > 0, archiveCount, totalEntries };
  } catch {
    return null;
  }
}

/**
 * Recursively collect all .cbz file paths under rootDir.
 */
async function collectCbzFiles(rootDir, signal) {
  const results = [];
  async function walk(dir) {
    if (signal?.aborted) return;
    await new Promise((r) => setImmediate(r));
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (signal?.aborted) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && path.extname(e.name).toLowerCase() === '.cbz') {
        results.push(full);
      }
    }
  }
  await walk(rootDir);
  return results;
}

/**
 * Find a non-conflicting target folder path.
 * If "BaseName" exists, tries "BaseName (1)", "BaseName (2)", …
 */
function resolveTargetFolder(parentDir, baseName) {
  const base = path.join(parentDir, baseName);
  if (!fs.existsSync(base)) return base;
  let n = 1;
  while (fs.existsSync(path.join(parentDir, `${baseName} (${n})`))) n++;
  return path.join(parentDir, `${baseName} (${n})`);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Scan rootDir for bundle CBZs (CBZs containing other archives).
 * Returns { groups } where each group has metadata for the preview.
 */
async function scanBundles(rootDir, log, sendProgress, signal) {
  log('Collecting CBZ files…', 'info');

  const allCbzFiles = await collectCbzFiles(rootDir, signal);
  if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

  const total = allCbzFiles.length;
  log(`Found ${total} CBZ file(s) — checking contents…`, 'info');

  const groups = [];
  for (let i = 0; i < allCbzFiles.length; i++) {
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    await new Promise((r) => setImmediate(r));
    sendProgress?.(i + 1, total);

    const cbzPath = allCbzFiles[i];
    const peek    = await peekCbz(cbzPath);
    if (!peek || !peek.hasArchives) continue;

    const parentDir      = path.dirname(cbzPath);
    const baseName       = path.basename(cbzPath, '.cbz');
    const cbzRel         = path.relative(rootDir, cbzPath);

    // Preview the target folder name (actual conflict resolution happens at apply time)
    const previewTarget    = resolveTargetFolder(parentDir, baseName);
    const previewTargetRel = path.relative(rootDir, previewTarget);

    groups.push({
      cbzPath,
      cbzRel,
      parentDir,
      baseName,
      previewTarget,
      previewTargetRel,
      archiveCount:  peek.archiveCount,
      totalEntries:  peek.totalEntries,
    });
  }

  log(
    groups.length > 0
      ? `Found ${groups.length} bundle CBZ(s) to unwrap.`
      : 'No bundle CBZs found — all CBZs contain only images.',
    groups.length > 0 ? 'success' : 'info'
  );

  return { groups };
}

/**
 * Extract each bundle CBZ into its own folder.
 * Returns { unwrapped, failed, extracted }
 * where extracted is [{ cbzPath, cbzRel, targetFolder, targetFolderRel }].
 */
async function applyUnwrap(rootDir, groups, log, sendProgress, signal) {
  const sz = getSevenZip();
  if (!sz) {
    log('7-Zip not found — cannot extract.', 'error');
    return { unwrapped: 0, failed: groups.length, extracted: [] };
  }

  const total    = groups.length;
  let   unwrapped = 0;
  let   failed    = 0;
  const extracted = [];

  sendProgress?.(0, total);

  for (let i = 0; i < groups.length; i++) {
    if (signal?.aborted) break;

    const { cbzPath, cbzRel, parentDir, baseName } = groups[i];

    // Re-resolve target folder at apply time in case state changed
    const targetFolder    = resolveTargetFolder(parentDir, baseName);
    const targetFolderRel = path.relative(rootDir, targetFolder);

    const numbered = path.basename(targetFolder) !== baseName;
    log(
      `Extracting: ${cbzRel}  →  ${targetFolderRel}` + (numbered ? '  (renamed to avoid conflict)' : ''),
      'info'
    );

    try {
      fs.mkdirSync(targetFolder, { recursive: true });

      await execFileAsync(sz, ['x', cbzPath, `-o${targetFolder}`, '-y'], {
        windowsHide: true,
      });

      log(`  Done: ${targetFolderRel}`, 'success', targetFolder);
      unwrapped++;
      extracted.push({ cbzPath, cbzRel, targetFolder, targetFolderRel });
    } catch (err) {
      log(`  Failed to extract "${cbzRel}": ${err.message}`, 'error');
      failed++;
      // Clean up partial extraction
      try { fs.rmSync(targetFolder, { recursive: true, force: true }); } catch {}
    }

    sendProgress?.(i + 1, total);
  }

  return { unwrapped, failed, extracted };
}

module.exports = { scanBundles, applyUnwrap };

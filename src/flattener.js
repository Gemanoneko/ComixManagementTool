'use strict';

/**
 * Fix the Library — Flatten redundant single-subfolder nesting.
 *
 * Trigger condition:
 *   A directory contains exactly ONE subdirectory and ZERO .cbz files.
 *   → Move all contents of that subdirectory up into the parent, remove
 *     the now-empty subdirectory.
 *
 * Extra housekeeping:
 *   Any _organise_undo.json or _consolidate_undo.json files found during
 *   the walk are deleted quietly.
 *
 * Recursion:
 *   Chains like A → B → C (each single-child) are handled by sorting
 *   groups deepest-first before applying, so B→C is resolved before A→B.
 */

const fs   = require('fs');
const path = require('path');

const JUNK_FILES = ['_organise_undo.json', '_consolidate_undo.json'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function moveItem(src, dst) {
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err.code === 'EXDEV') {
      // Cross-device: copy + delete
      fs.copyFileSync(src, dst);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

function depth(p) {
  return p.split(path.sep).length;
}

// ─── Phase 1: Scan ────────────────────────────────────────────────────────────

/**
 * Walk rootDir, find every directory that qualifies for flattening, and
 * delete any stale journal files along the way.
 *
 * Returns:
 *   {
 *     groups: [{
 *       outer:     string,  // absolute path of the outer (parent) folder
 *       outerRel:  string,  // relative to rootDir (for display)
 *       inner:     string,  // absolute path of the single child folder
 *       innerName: string,  // just the folder name (for display)
 *       itemCount: number,  // number of items inside inner
 *     }],
 *     journalsDeleted: number,
 *   }
 *
 * Groups are sorted deepest-first so chains are applied in the right order.
 */
async function scanFlattenable(rootDir, log, sendProgress, signal) {
  const groups         = [];
  let journalsDeleted  = 0;
  let foldersVisited   = 0;

  async function walk(dir) {
    if (signal?.aborted) return;
    await new Promise((r) => setImmediate(r));
    foldersVisited++;
    sendProgress?.(foldersVisited, 0);  // total=0 → indeterminate

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    // ── Delete stale journal / cache files ────────────────────────────────────
    for (const jf of JUNK_FILES) {
      if (entries.some((e) => e.isFile() && e.name === jf)) {
        try {
          fs.unlinkSync(path.join(dir, jf));
          journalsDeleted++;
          log(`  Deleted: ${path.relative(rootDir, path.join(dir, jf)) || jf}`, 'info');
        } catch { /* ignore permission errors */ }
      }
    }

    // Re-read so deleted files aren't counted
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    const subdirs = entries.filter((e) => e.isDirectory());
    const files   = entries.filter((e) => e.isFile());

    // ── Check flatten condition ───────────────────────────────────────────────
    // Only flag if there is exactly one subfolder AND no files of any kind.
    if (subdirs.length === 1 && files.length === 0) {
      const innerName = subdirs[0].name;
      const inner     = path.join(dir, innerName);

      let innerEntries = [];
      try { innerEntries = fs.readdirSync(inner, { withFileTypes: true }); } catch { /* skip */ }

      groups.push({
        outer:     dir,
        outerRel:  path.relative(rootDir, dir) || path.basename(rootDir),
        inner,
        innerName,
        itemCount: innerEntries.length,
      });
    }

    // ── Recurse into every subdirectory ───────────────────────────────────────
    for (const e of subdirs) {
      if (signal?.aborted) return;
      await walk(path.join(dir, e.name));
    }
  }

  log(`Scanning ${rootDir} …`, 'header');
  await walk(rootDir);

  // Deepest-first so chains (A→B→C) resolve inner links before outer ones
  groups.sort((a, b) => depth(b.outer) - depth(a.outer));

  const msg = groups.length === 0
    ? 'No flattenable folders found.'
    : `Found ${groups.length} folder(s) to flatten.`;
  log(
    msg + (journalsDeleted > 0 ? `  (${journalsDeleted} stale journal file(s) deleted)` : ''),
    groups.length === 0 ? 'info' : 'success'
  );

  return { groups, journalsDeleted };
}

// ─── Phase 2: Apply ───────────────────────────────────────────────────────────

/**
 * Execute the flatten operations for the given groups (already deepest-first).
 *
 * Before each operation the condition is re-verified — state may have changed
 * if this folder was involved in a deeper flatten that already ran.
 *
 * Returns { flattened, failed }
 */
async function applyFlatten(rootDir, groups, log, sendProgress, signal) {
  let flattened = 0;
  let failed    = 0;
  const flattenedRels = [];
  const failedRels    = [];

  const total = groups.length;
  let done    = 0;
  sendProgress?.(0, total);

  for (const { outer, outerRel, inner, innerName } of groups) {
    if (signal?.aborted) break;

    // ── Re-verify outer folder still qualifies ────────────────────────────────
    if (!fs.existsSync(inner)) {
      // Inner was already absorbed by a deeper-level flatten — nothing to do
      log(`  Already resolved: ${outerRel}`, 'info');
      continue;
    }

    let outerEntries;
    try { outerEntries = fs.readdirSync(outer, { withFileTypes: true }); } catch { continue; }

    const outerSubdirs = outerEntries.filter((e) => e.isDirectory());
    const outerFiles   = outerEntries.filter((e) => e.isFile());

    if (outerSubdirs.length !== 1 || outerFiles.length !== 0) {
      log(`  Skipped (conditions changed): ${outerRel}`, 'warn');
      continue;
    }

    // ── Move every item from inner → outer ────────────────────────────────────
    let innerEntries;
    try { innerEntries = fs.readdirSync(inner, { withFileTypes: true }); } catch { continue; }

    let itemsMoved    = 0;
    let itemsConflict = 0;

    for (const e of innerEntries) {
      if (signal?.aborted) break;
      await new Promise((r) => setImmediate(r));

      const src = path.join(inner, e.name);
      const dst = path.join(outer, e.name);

      if (fs.existsSync(dst)) {
        log(`  Conflict (skipped): ${e.name} in ${outerRel}`, 'warn');
        itemsConflict++;
        continue;
      }

      try {
        if (e.isDirectory()) {
          fs.renameSync(src, dst);          // directories always rename (same vol or EXDEV ok)
        } else {
          moveItem(src, dst);
        }
        itemsMoved++;
      } catch (err) {
        log(`  Failed to move "${e.name}": ${err.message}`, 'error');
        itemsConflict++;
      }
    }

    // ── Remove now-empty inner folder ─────────────────────────────────────────
    try {
      const remaining = fs.readdirSync(inner);
      if (remaining.length === 0) {
        fs.rmdirSync(inner);
        log(
          `  Flattened: ${outerRel}  ←  ${innerName}` +
          (itemsMoved > 0 ? `  (${itemsMoved} item(s) moved)` : ''),
          'success',
          outer
        );
        flattened++;
        flattenedRels.push(outerRel);
      } else {
        log(
          `  Partial: "${innerName}" still has ${remaining.length} item(s) — conflicts prevented full flatten`,
          'warn'
        );
        failed++;
        failedRels.push(outerRel);
      }
    } catch (err) {
      log(`  Could not remove "${innerName}": ${err.message}`, 'error');
      failed++;
      failedRels.push(outerRel);
    }

    done++;
    sendProgress?.(done, total);

  }

  return { flattened, failed, flattenedRels, failedRels };
}

// ─── Delete empty folders ─────────────────────────────────────────────────────

/**
 * Recursively walk rootDir bottom-up (deepest-first) and delete every
 * directory that is completely empty.  Directories that become empty after
 * their children are deleted are also removed in the same pass.
 *
 * Returns { deleted: string[] }  — relative paths of every directory removed.
 */
async function deleteEmptyFolders(rootDir, log, sendProgress, signal) {
  const deleted = [];
  let foldersVisited = 0;

  async function walk(dir) {
    if (signal?.aborted) return;
    await new Promise((r) => setImmediate(r));
    foldersVisited++;
    sendProgress?.(foldersVisited, 0);  // total=0 → indeterminate

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    // Recurse into subdirs first (bottom-up)
    for (const e of entries) {
      if (signal?.aborted) return;
      if (e.isDirectory()) await walk(path.join(dir, e.name));
    }

    // Re-read after children may have been removed
    let current;
    try { current = fs.readdirSync(dir); } catch { return; }

    if (current.length === 0 && dir !== rootDir) {
      try {
        fs.rmdirSync(dir);
        const rel = path.relative(rootDir, dir);
        deleted.push(rel);
        log(`  Deleted empty folder: ${rel}`, 'info');
      } catch (err) {
        log(`  Could not delete "${path.relative(rootDir, dir)}": ${err.message}`, 'warn');
      }
    }
  }

  log(`Scanning for empty folders in ${rootDir} …`, 'header');
  await walk(rootDir);

  if (deleted.length === 0) {
    log('No empty folders found.', 'info');
  } else {
    log(`Deleted ${deleted.length} empty folder(s).`, 'success');
  }

  return { deleted };
}

module.exports = { scanFlattenable, applyFlatten, deleteEmptyFolders };

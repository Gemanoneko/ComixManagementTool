'use strict';

const { execFile } = require('child_process');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');

const { getSevenZip, getImageMagick } = require('./tools');
const { validateCbz }                 = require('./validator');

const IMAGE_EXTS    = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif']);
const MAX_LONG_SIDE = 4500;
const QUALITY       = 90;
const BATCH_SIZE    = 50;

// ── Helpers ───────────────────────────────────────────────────────────────────

function execFilePromise(cmd, args, signal, execOpts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd, args,
      { maxBuffer: 512 * 1024 * 1024, ...execOpts },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }));
        else     resolve({ stdout, stderr });
      }
    );
    if (signal) {
      signal.addEventListener('abort', () => { try { child.kill(); } catch {} }, { once: true });
    }
  });
}

function formatBytes(bytes) {
  if (bytes <= 0)              return '0 B';
  if (bytes < 1024)            return `${bytes} B`;
  if (bytes < 1024 * 1024)     return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)       return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function scanCbz(folder) {
  const results = [];
  async function walk(dir) {
    await new Promise((r) => setImmediate(r)); // yield so IPC messages can be processed
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && path.extname(e.name).toLowerCase() === '.cbz') results.push(full);
    }
  }
  await walk(folder);
  return results;
}

/**
 * Run `magick identify -ping -format "%f\t%w\t%h\n"` on files in batches.
 * Returns a Map<filePath, { w, h }>.
 */
async function identifyImages(imageMagick, files, signal) {
  const dims = new Map();
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    let stdout;
    try {
      ({ stdout } = await execFilePromise(
        imageMagick,
        ['identify', '-ping', '-format', '%f\t%w\t%h\n', ...batch],
        signal
      ));
    } catch (err) {
      // When signal aborts, child.kill() fires but the error won't carry
      // name:'AbortError' — check signal directly so we propagate cleanly.
      if (err.name === 'AbortError' || signal?.aborted) throw err;
      continue; // batch failed for another reason; skip it (those pages won't be flagged)
    }
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const name = parts[0].trim();
      const w    = parseInt(parts[1], 10);
      const h    = parseInt(parts[2], 10);
      if (!name || isNaN(w) || isNaN(h)) continue;
      // Match basename back to full path (all files in tmpDir, basenames unique)
      const full = batch.find((f) => path.basename(f) === name);
      if (full) dims.set(full, { w, h });
    }
  }
  return dims;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Scans `folder` recursively for CBZ files, identifies oversized pages,
 * resizes them (never upscales), repacks, and validates.
 *
 * Each result item carries { original, tmp, pagesResized, totalPages, originalSize, newSize }
 * so the caller can compute and display space savings.
 *
 * @param {{ folder: string }} options
 * @param {(msg: string, type?: string) => void} sendLog
 * @param {(current: number, total: number) => void} sendProgress
 * @param {AbortSignal} signal
 * @returns {Promise<{ resized: Array, skipped: number, errors: Array, totalSavedBytes: number }>}
 */
async function startResize({ folder }, sendLog, sendProgress, signal) {
  const sevenZip    = getSevenZip();
  const imageMagick = getImageMagick();
  if (!sevenZip)    throw new Error('7-Zip not found — cannot resize CBZs');
  if (!imageMagick) throw new Error('ImageMagick not found — cannot resize CBZs');

  sendLog('Scanning for CBZ files…', 'info');
  const cbzFiles = await scanCbz(folder);

  if (cbzFiles.length === 0) {
    sendLog('No CBZ files found.', 'warn');
    return { resized: [], skipped: 0, errors: [], totalSavedBytes: 0 };
  }

  sendLog(`Found ${cbzFiles.length} CBZ file(s). Checking page dimensions…`, 'info');

  const resized = [];
  let   skipped = 0;
  const errors  = [];

  for (let i = 0; i < cbzFiles.length; i++) {
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

    const cbzPath = cbzFiles[i];
    sendProgress(i, cbzFiles.length);
    sendLog(`[${i + 1}/${cbzFiles.length}] ${path.basename(cbzPath)}`, 'header');

    const tmpDir = path.join(os.tmpdir(), `cbz_resize_${crypto.randomBytes(6).toString('hex')}`);
    let   tmpCbz = null;

    try {
      fs.mkdirSync(tmpDir, { recursive: true });

      // Record original size for savings calculation
      const originalSize = fs.statSync(cbzPath).size;

      // 1. Extract flat (no subdirs) into tmpDir
      await execFilePromise(sevenZip, ['e', cbzPath, `-o${tmpDir}`, '-y'], signal);

      // 2. Collect image files, sorted for correct page order
      const allFiles = fs.readdirSync(tmpDir)
        .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((f) => path.join(tmpDir, f));

      if (allFiles.length === 0) {
        sendLog('  No image files found — skipped.', 'skip');
        skipped++;
        continue;
      }

      // 3. Identify dimensions; find oversized pages
      const dims      = await identifyImages(imageMagick, allFiles, signal);
      const oversized = allFiles.filter((f) => {
        const d = dims.get(f);
        return d && Math.max(d.w, d.h) > MAX_LONG_SIDE;
      });

      if (oversized.length === 0) {
        sendLog(`  All ${allFiles.length} pages within ${MAX_LONG_SIDE}px — skipped.`, 'skip');
        skipped++;
        continue;
      }

      sendLog(
        `  ${oversized.length} / ${allFiles.length} page(s) exceed ${MAX_LONG_SIDE}px — resizing…`,
        'info'
      );

      // 4. Mogrify oversized pages in-place (never upscales — ">" flag).
      //    Batch into groups of BATCH_SIZE to stay well under the Windows
      //    32 767-character command-line limit for large artbooks.
      for (let b = 0; b < oversized.length; b += BATCH_SIZE) {
        const batch = oversized.slice(b, b + BATCH_SIZE);
        await execFilePromise(
          imageMagick,
          ['mogrify', '-resize', `${MAX_LONG_SIDE}x${MAX_LONG_SIDE}>`, '-quality', String(QUALITY), ...batch],
          signal
        );
      }

      // 5. Pack all pages into a new temp CBZ via 7-Zip store mode
      tmpCbz = path.join(os.tmpdir(), `cbz_resized_${crypto.randomBytes(6).toString('hex')}.cbz`);
      const basenames = allFiles.map((f) => path.basename(f));
      const listPath  = path.join(tmpDir, '.cbzpack.lst');
      fs.writeFileSync(listPath, basenames.join('\n'), 'utf8');
      try {
        await execFilePromise(
          sevenZip,
          ['a', '-tzip', '-mx=0', tmpCbz, `@${listPath}`],
          signal,
          { cwd: tmpDir }
        );
      } catch (err) {
        try { fs.unlinkSync(tmpCbz); } catch {}
        throw err;
      } finally {
        try { fs.unlinkSync(listPath); } catch {}
      }

      // 6. Validate the new CBZ
      const { valid, reason } = await validateCbz(tmpCbz, allFiles.length);
      if (!valid) {
        sendLog(`  Validation failed: ${reason}`, 'error');
        try { fs.unlinkSync(tmpCbz); } catch {}
        errors.push({ file: cbzPath, reason });
        tmpCbz = null;
        continue;
      }

      const newSize  = fs.statSync(tmpCbz).size;
      const saved    = originalSize - newSize;
      const savedStr = saved > 0 ? ` (saves ${formatBytes(saved)})` : '';

      sendLog(
        `  OK — ${oversized.length} page(s) resized${savedStr}. Pending confirmation.`,
        'success'
      );
      resized.push({
        original:     cbzPath,
        tmp:          tmpCbz,
        pagesResized: oversized.length,
        totalPages:   allFiles.length,
        originalSize,
        newSize,
      });
      tmpCbz = null; // ownership transferred to result; caller cleans up

    } catch (err) {
      // Check signal?.aborted in addition to name check: when a child process is
      // killed via child.kill(), the execFile error does not carry name:'AbortError'.
      if (err.name === 'AbortError' || signal?.aborted) {
        if (tmpCbz) try { fs.unlinkSync(tmpCbz); } catch {}
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      }
      // Prefer stderr (clean 7-Zip / ImageMagick error text) over err.message,
      // which includes the full command invocation and is very noisy.
      const reason = err.stderr?.trim() || err.message;
      sendLog(`  ERROR: ${reason}`, 'error');
      errors.push({ file: cbzPath, reason });
    } finally {
      try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  sendProgress(cbzFiles.length, cbzFiles.length);

  // Summary
  const totalSavedBytes = resized.reduce((sum, r) => sum + Math.max(0, r.originalSize - r.newSize), 0);
  if (resized.length > 0) {
    sendLog(
      `\nReady — ${resized.length} file(s) to replace, ${formatBytes(totalSavedBytes)} to be freed.`,
      'success'
    );
  }
  if (errors.length > 0) {
    sendLog(`${errors.length} file(s) failed — see above for details.`, 'warn');
  }

  return { resized, skipped, errors, totalSavedBytes };
}

module.exports = { startResize };

'use strict';

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');

const { execFilePromise } = require('./exec');
const { sevenZipArgs }    = require('./seven-zip');
const { getSevenZip, getImageMagick } = require('./tools');
const { validateCbz }                 = require('./validator');

const IMAGE_EXTS    = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif']);
// 7-Zip include-filter args — extract only image files so that non-image
// entries (PDFs, config dirs, etc.) inside CBZs are never touched and
// never cause "Cannot create folder" conflicts.
const IMAGE_INCLUDE_ARGS = [...IMAGE_EXTS].map((ext) => `-i!*${ext}`);
const MAX_LONG_SIDE = 4500;
const QUALITY       = 90;
const BATCH_SIZE    = 50;
// Process this many CBZ files concurrently. Each worker holds one temp dir on
// disk at a time, so keep this conservative to avoid saturating the drive.
const CONCURRENCY   = Math.min(os.cpus().length, 4);

// ── Helpers ───────────────────────────────────────────────────────────────────

// On Windows, prepend \\?\ to absolute paths so child processes (7-Zip, etc.)
// can accept paths longer than the default 260-character MAX_PATH limit.
// The \\?\ prefix bypasses MAX_PATH regardless of whether "Enable Long Paths"
// is enabled in Windows settings.
function longPath(p) {
  if (process.platform !== 'win32' || !path.isAbsolute(p)) return p;
  if (p.startsWith('\\\\')) return p; // already UNC or \\?\
  return '\\\\?\\' + path.normalize(p);
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

// ── Fast image-dimension reader (no external process) ─────────────────────────
//
// Reads only the header bytes of each image file to extract width × height.
// This replaces spawning `magick identify` (a new process per batch), which
// dominates per-file time on large libraries.
//
// Supported natively: JPEG, PNG, GIF, BMP, WebP.
// Unsupported (TIFF, AVIF, …): getDimensions returns null → treated as within
// limits and left untouched.  These formats are rare in CBZ collections.

function parseDimensions(buf, ext) {
  // ── PNG ── 8-byte sig; IHDR at offset 8: width @16, height @20 (BE uint32)
  if (ext === '.png') {
    if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }

  // ── GIF ── "GIF87a" / "GIF89a"; width @6, height @8 (LE uint16)
  if (ext === '.gif') {
    if (buf.length < 10 || buf[0] !== 0x47 || buf[1] !== 0x49) return null;
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }

  // ── BMP ── "BM" header; width @18, height @22 (LE int32; negative = top-down)
  if (ext === '.bmp') {
    if (buf.length < 26 || buf[0] !== 0x42 || buf[1] !== 0x4D) return null;
    return { w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
  }

  // ── WebP ── RIFF container; three sub-formats
  if (ext === '.webp') {
    if (buf.length < 30) return null;
    if (buf.toString('latin1', 0, 4) !== 'RIFF' ||
        buf.toString('latin1', 8, 12) !== 'WEBP') return null;
    const fmt = buf.toString('latin1', 12, 16);
    if (fmt === 'VP8 ') {  // lossy
      return { w: (buf.readUInt16LE(26) & 0x3FFF) + 1,
               h: (buf.readUInt16LE(28) & 0x3FFF) + 1 };
    }
    if (fmt === 'VP8L') {  // lossless — 4 packed bytes at offset 21
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3FFF) + 1, h: ((b >> 14) & 0x3FFF) + 1 };
    }
    if (fmt === 'VP8X') {  // extended — 24-bit LE at offsets 24 / 27
      return { w: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
               h: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1 };
    }
    return null;
  }

  // ── JPEG ── scan marker chain for SOF0/SOF2/… segment
  if (ext === '.jpg' || ext === '.jpeg') {
    if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
    let i = 2;
    while (i + 8 < buf.length) {
      if (buf[i] !== 0xFF) break;
      const m = buf[i + 1];
      if (m === 0xD9 || m === 0xDA) break; // EOI / SOS — no more header segments
      // SOF markers: C0-C3, C5-C7, C9-CB, CD-CF
      if ((m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7) ||
          (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF)) {
        // [FF][marker][len 2B][precision 1B][height 2B][width 2B]
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      if (m === 0xFF) { i++; continue; } // padding byte — skip
      const segLen = buf.readUInt16BE(i + 2);
      if (segLen < 2) break;
      i += 2 + segLen;
    }
    return null;
  }

  return null; // TIFF, AVIF, etc. — not supported natively
}

async function getDimensions(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  // JPEG SOF can appear after a large EXIF block — read up to 64 KB.
  // All other formats have dimensions in their first ≤ 30 bytes.
  const readSize = (ext === '.jpg' || ext === '.jpeg') ? 65536 : 64;
  try {
    const fh = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    const { bytesRead } = await fh.read(buf, 0, readSize, 0);
    await fh.close();
    return parseDimensions(buf.subarray(0, bytesRead), ext);
  } catch {
    return null;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Scans `folder` recursively for CBZ files, identifies oversized pages,
 * resizes them (never upscales), repacks, and validates.
 *
 * CBZs are processed CONCURRENCY-at-a-time.  Each worker:
 *   1. Extracts the CBZ with 7-Zip
 *   2. Reads image dimensions from file headers (pure Node.js — no process spawn)
 *   3. If any page > MAX_LONG_SIDE: mogrify + repack + validate
 *   4. Otherwise: skip
 *
 * @param {{ folder: string }} options
 * @param {(msg: string, type?: string) => void} sendLog
 * @param {(current: number, total: number) => void} sendProgress
 * @param {AbortSignal} signal
 * @returns {Promise<{ resized: Array, skipped: number, errors: Array, totalSavedBytes: number }>}
 */
async function startResize({ folder }, sendLog, sendProgress, signal, waitIfPaused) {
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

  sendLog(`Found ${cbzFiles.length} CBZ file(s). Processing with ${CONCURRENCY} worker(s)…`, 'info');
  sendProgress(0, cbzFiles.length);

  // Shared state — safe to mutate without locks (JS is single-threaded)
  const resized = [];
  let   skipped = 0;
  const errors  = [];
  let   done    = 0;

  // ── Worker pool ───────────────────────────────────────────────────────────
  // nextIdx is read-and-incremented synchronously, so each worker gets a
  // unique file index with no races.
  let nextIdx = 0;

  async function processOne() {
    while (true) {
      if (signal?.aborted) return;
      if (waitIfPaused) {
        try { await waitIfPaused(signal); } catch (err) {
          if (err.name === 'AbortError' || signal?.aborted) return;
          throw err;
        }
      }
      const i = nextIdx++;
      if (i >= cbzFiles.length) return;

      const cbzPath = cbzFiles[i];
      const tag     = `[${i + 1}/${cbzFiles.length}]`;
      const log     = (msg, type = 'info') => sendLog(`${tag} ${msg}`, type);

      log(path.basename(cbzPath), 'header');

      // m6: mkdtempSync is atomic and guaranteed unique — matches the
      // converter.js `cbz_` pattern and removes the manual-randomBytes +
      // mkdirSync race that could theoretically collide.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbz_resize_'));
      let   tmpCbz = null;

      try {

        const originalSize = fs.statSync(cbzPath).size;

        // 1. Extract flat (no subdirs) into tmpDir, images only.
        //    • longPath() adds \\?\ so 7-Zip can open CBZs whose full path
        //      exceeds the Windows 260-character MAX_PATH limit.
        //    • IMAGE_INCLUDE_ARGS restrict extraction to image extensions so
        //      non-image entries (e.g. a "config" directory) are never
        //      processed and never cause "Cannot create folder" conflicts.
        //    • 7-Zip exit code 1 = warnings only (e.g. "Unexpected end of
        //      archive" on a truncated file).  We log it and continue with
        //      whatever pages were extracted rather than aborting the file.
        try {
          await execFilePromise(
            sevenZip,
            sevenZipArgs(
              'e',
              [`-o${longPath(tmpDir)}`, '-y', ...IMAGE_INCLUDE_ARGS, '-i!*.xml', '-i!*.XML'],
              longPath(cbzPath),
            ),
            signal
          );
        } catch (err) {
          if (err.name === 'AbortError' || signal?.aborted) throw err;
          if (err.code !== 1) throw err; // code 1 = non-fatal warnings — continue
          log(`Archive warning: ${(err.stderr?.trim() || err.message).split('\n')[0]}`, 'warn');
        }

        // 2. Collect image files, sorted for correct page order
        const allFiles = fs.readdirSync(tmpDir)
          .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .map((f) => path.join(tmpDir, f));

        // Also collect any XML metadata files (e.g. ComicInfo.xml)
        const xmlFiles = fs.readdirSync(tmpDir)
          .filter((f) => path.extname(f).toLowerCase() === '.xml')
          .map((f) => path.join(tmpDir, f));

        if (allFiles.length === 0) {
          log('No image files found — skipped.', 'skip');
          skipped++;
          continue;
        }

        // 3. Read image dimensions from file headers — no external process needed.
        //    getDimensions reads at most 64 KB per file (for JPEG) or 64 bytes
        //    (for PNG/GIF/BMP/WebP).  All reads run concurrently via Promise.all.
        const dims = new Map();
        await Promise.all(allFiles.map(async (f) => {
          const d = await getDimensions(f);
          if (d) dims.set(f, d);
        }));

        if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

        const oversized = allFiles.filter((f) => {
          const d = dims.get(f);
          return d && Math.max(d.w, d.h) > MAX_LONG_SIDE;
        });

        if (oversized.length === 0) {
          log(`All ${allFiles.length} pages within ${MAX_LONG_SIDE}px — skipped.`, 'skip');
          skipped++;
          continue;
        }

        log(`${oversized.length} / ${allFiles.length} page(s) exceed ${MAX_LONG_SIDE}px — resizing…`, 'info');

        // 4. Mogrify oversized pages in-place (never upscales — ">" flag).
        //    Use basenames + cwd so the command line never contains long image
        //    paths (internal CBZ filenames can also exceed MAX_PATH when joined
        //    with a temp dir prefix).
        //    Batch into groups of BATCH_SIZE to stay under the Windows
        //    32 767-character command-line limit for large artbooks.
        for (let b = 0; b < oversized.length; b += BATCH_SIZE) {
          if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
          const batch = oversized.slice(b, b + BATCH_SIZE).map((f) => path.basename(f));
          await execFilePromise(
            imageMagick,
            ['mogrify', '-resize', `${MAX_LONG_SIDE}x${MAX_LONG_SIDE}>`, '-quality', String(QUALITY), ...batch],
            signal,
            { cwd: tmpDir }
          );
        }

        // 5. Pack all pages (+ any XML metadata files) into a new temp CBZ via 7-Zip store mode
        tmpCbz = path.join(os.tmpdir(), `cbz_resized_${crypto.randomBytes(6).toString('hex')}.cbz`);
        const basenames = [...allFiles, ...xmlFiles].map((f) => path.basename(f));
        const listPath  = path.join(tmpDir, '.cbzpack.lst');
        fs.writeFileSync(listPath, basenames.join('\n'), 'utf8');
        try {
          await execFilePromise(
            sevenZip,
            // `@listPath` is a 7-Zip listfile switch — the helper detects it
            // and emits an argv shape with no `--` and the listfile as the
            // trailing positional (per 7-Zip's grammar, `--` stops @listfile
            // parsing). Switch-injection on `tmpCbz` is still blocked because
            // the helper prefixes `.\` to any operand starting with `-`.
            sevenZipArgs('a', ['-tzip', '-mx=0', `@${listPath}`], tmpCbz),
            signal,
            { cwd: tmpDir }
          );
        } catch (err) {
          try { await fs.promises.unlink(tmpCbz); } catch {}
          throw err;
        } finally {
          try { fs.unlinkSync(listPath); } catch {}
        }

        // 6. Validate the new CBZ
        const { valid, reason } = await validateCbz(tmpCbz, allFiles.length);
        if (!valid) {
          log(`Validation failed: ${reason}`, 'error');
          try { await fs.promises.unlink(tmpCbz); } catch {}
          errors.push({ file: cbzPath, reason });
          tmpCbz = null;
          continue;
        }

        const newSize  = fs.statSync(tmpCbz).size;
        const saved    = originalSize - newSize;
        log(
          `OK — ${oversized.length} page(s) resized${saved > 0 ? ` (saves ${formatBytes(saved)})` : ''}. Pending confirmation.`,
          'success'
        );
        resized.push({
          original: cbzPath, tmp: tmpCbz,
          pagesResized: oversized.length, totalPages: allFiles.length,
          originalSize, newSize,
        });
        tmpCbz = null; // ownership transferred to caller

      } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) {
          if (tmpCbz) try { await fs.promises.unlink(tmpCbz); } catch {}
          return; // let worker exit cleanly; abort is detected at top of next iteration
        }
        const reason = err.stderr?.trim() || err.message;
        log(`ERROR: ${reason}`, 'error');
        errors.push({ file: cbzPath, reason });
      } finally {
        try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch {}
        done++;
        sendProgress(done, cbzFiles.length);
      }
    }
  }

  // Promise.allSettled waits for every worker to finish (including draining
  // after an abort), so no worker is left running after startResize returns.
  await Promise.allSettled(Array.from({ length: CONCURRENCY }, processOne));

  sendProgress(done, cbzFiles.length);

  if (signal?.aborted) {
    // Return partial results so the caller can offer to apply or discard
    // any files that finished resizing before the cancel was processed.
    const totalSavedBytes = resized.reduce((sum, r) => sum + Math.max(0, r.originalSize - r.newSize), 0);
    return { resized, skipped, errors, totalSavedBytes, aborted: true };
  }

  sendProgress(cbzFiles.length, cbzFiles.length);

  const totalSavedBytes = resized.reduce((sum, r) => sum + Math.max(0, r.originalSize - r.newSize), 0);
  if (resized.length > 0) {
    sendLog(`\nReady — ${resized.length} file(s) to replace, ${formatBytes(totalSavedBytes)} to be freed.`, 'success');
  }
  if (errors.length > 0) {
    sendLog(`${errors.length} file(s) failed — see above for details.`, 'warn');
  }

  return { resized, skipped, errors, totalSavedBytes };
}

module.exports = { startResize };

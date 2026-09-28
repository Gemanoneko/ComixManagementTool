'use strict';

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');

const { execFilePromise } = require('./exec');
const { sevenZipArgs, listFileContent, errorLine } = require('./seven-zip');
const { getSevenZip, getImageMagick } = require('./tools');
const { validateCbz, countImageEntries, listEntries, compareEntries } = require('./validator');
const { tempRoot } = require('./temp');
const { formatBytes } = require('./format');

const IMAGE_EXTS    = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif']);
const MAX_LONG_SIDE = 4500;
const QUALITY       = 90;
const BATCH_SIZE    = 50;
// Room for mogrify's page arguments on one command line (Windows allows 32 767
// characters in all; the rest is the executable and the switches).
const MAX_CMDLINE   = 30000;
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

/**
 * The name 7-Zip gives an archive path when it extracts on Windows: a name
 * can't end in a space or a period there, so 7-Zip writes each such trailing
 * character as "_" — "Vol 1 \001.jpg" lands as "Vol 1_\001.jpg", "notes.txt "
 * as "notes.txt_".  (7-Zip has no switch to turn this off.)  A name made
 * only of spaces and periods ("..", "   ") is left as it is: 7-Zip treats
 * those differently, and such an archive keeps failing the exact-copy check.
 */
function extractedPath(p) {
  return p.split('\\').map((c) => c.replace(/([^ .])([ .]+)$/, (_, last, run) => last + '_'.repeat(run.length))).join('\\');
}

/**
 * The renames that give a repack its original's entry names back:
 * [packed path, original path] for every entry of the original that was
 * extracted only under 7-Zip's name for it (extractedPath).  Nothing is
 * guessed: a pair is made only when that name is in the repack, and never when
 * two entries of the original land on the same name ("Vol 1 \" and "Vol 1_\"
 * both extract into "Vol 1_\") — 7-Zip merged those, and the exact-copy check
 * must fail.  Windows names are case-insensitive, so the lookups are too.
 *
 * @param {Array<{path: string}>} sourceEntries  the original's listing
 * @param {string[]} packedPaths                 paths in the repack, relative
 * @returns {Array<[string, string]>}
 */
function restoreNamePairs(sourceEntries, packedPaths) {
  const norm   = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '');
  const packed = new Map(packedPaths.map((p) => [p.toLowerCase(), p]));
  const lands  = new Map();                        // name on disk (lower) → how many originals land there
  for (const e of sourceEntries) {
    const k = extractedPath(norm(e.path)).toLowerCase();
    lands.set(k, (lands.get(k) || 0) + 1);
  }
  const pairs = [];
  for (const e of sourceEntries) {
    const want = norm(e.path);
    const got  = extractedPath(want);
    if (got === want || packed.has(want.toLowerCase()) || /["\r\n]/.test(want)) continue;   // " / newline: no listfile line
    const k = got.toLowerCase();
    if (packed.has(k) && lands.get(k) === 1) pairs.push([packed.get(k), want]);
  }
  return pairs;
}

/**
 * Recursively list everything under `root`, returning paths RELATIVE to root.
 * Returns { images, others, emptyDirs }:
 *   images     – page files, naturally sorted by relative path so pages keep
 *                their reading order (root pages first, then each subfolder)
 *   others     – every other file (ComicInfo.xml, .jxl, .jfif, .txt, …),
 *                carried over into the resized copy unchanged
 *   emptyDirs  – folders with nothing in them.  7-Zip only stores a folder
 *                entry when the folder itself is listed, and listing a
 *                non-empty folder would re-add its files, so only empty ones
 *                are listed; every other folder is implied by its files.
 */
function collectTree(root) {
  const images    = [];
  const others    = [];
  const emptyDirs = [];
  (function walk(dir, relDir) {
    const list = fs.readdirSync(dir, { withFileTypes: true });
    if (list.length === 0 && relDir) emptyDirs.push(relDir);
    for (const e of list) {
      const rel = relDir ? path.join(relDir, e.name) : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), rel); continue; }
      if (!e.isFile()) continue;   // anything else is missing from the repack → caught by step 6
      if (IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) images.push(rel);
      else others.push(rel);
    }
  })(root, '');
  const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  images.sort(byName);
  others.sort(byName);
  return { images, others, emptyDirs };
}

/** fsync a file so its data is on disk before it replaces anything. */
async function fsyncFile(p) {
  const fh = await fs.promises.open(p, 'r+');
  try { await fh.sync(); } finally { await fh.close(); }
}

/**
 * Replace `original` with the resized copy at `tmp` without ever leaving the
 * original half-written.
 *
 *   • Same volume: `rename` is an atomic replace (MoveFileEx
 *     REPLACE_EXISTING) — the original is either the old file or the new one.
 *   • Different volume (tmp lives in %TEMP%, library on another drive →
 *     EXDEV) or any other rename failure: the old code ran
 *     `copyFile(tmp, original)`, which truncates the original before writing,
 *     so a crash mid-copy destroyed it — and the next launch's `cbz_*` temp
 *     sweep then deleted the only complete copy.  Now the copy goes to a
 *     sibling temp file on the destination volume, is flushed, and only then
 *     renamed over the original (atomic, same volume).  A crash at any point
 *     leaves the original intact (plus, at worst, an ignorable `.tmp`
 *     sibling), so the %TEMP% copy is never the only surviving copy and the
 *     startup sweep cannot lose data.
 *
 * Throws on failure; the original is untouched in that case.
 *
 * `journalPath` (optional): before the sibling is created its full path is
 * appended there, so the next launch's sweepResizeLeftovers can remove a
 * sibling that a crash left behind.  Journal trouble never blocks a replace —
 * at worst a crash then leaves one harmless `.resize.tmp` file.
 */
async function replaceWithResized(tmp, original, journalPath = null) {
  await fsyncFile(tmp);
  try {
    await fs.promises.rename(tmp, original);
    return;
  } catch { /* EXDEV or similar — fall through to the destination-side copy */ }

  const sibling = `${original}.${crypto.randomBytes(4).toString('hex')}.resize.tmp`;
  if (journalPath) {
    try { await fs.promises.appendFile(journalPath, sibling + '\n', 'utf8'); } catch { /* best effort */ }
  }
  try {
    await fs.promises.copyFile(tmp, sibling, fs.constants.COPYFILE_EXCL);
    await fsyncFile(sibling);
    await fs.promises.rename(sibling, original);
  } catch (err) {
    try { await fs.promises.unlink(sibling); } catch {}
    throw err;
  }
  try { await fs.promises.unlink(tmp); } catch {}
}

// Exactly the sibling name replaceWithResized creates: "<name>.cbz" (any case
// of the extension, as scanCbz accepts) + "." + 8 lower-case hex digits +
// ".resize.tmp".  Group 1 is the original's file name.
const RESIZE_SIBLING_RE = /^(.+\.[cC][bB][zZ])\.[0-9a-f]{8}\.resize\.tmp$/;

/**
 * Startup sweep: delete `.resize.tmp` siblings that a crash in
 * replaceWithResized left beside their original.  Silent by design.
 *
 * Only paths replaceWithResized itself wrote to the journal are considered —
 * the library is never scanned — and each one is deleted only when
 *   • it is absolute and its file name exactly matches RESIZE_SIBLING_RE,
 *   • it is a regular file, and
 *   • the original "<name>.cbz" it was made for exists beside it as a file.
 * The original is intact in that case (the sibling only ever replaces it by
 * an atomic rename), so the sibling is a disposable partial copy.  Anything
 * else is left alone.  The journal is emptied once read.
 *
 * Async (never throws): a journal entry on a slow or offline network drive
 * must not hold up the window.
 *
 * @param {string} journalPath
 * @returns {Promise<void>}
 */
async function sweepResizeLeftovers(journalPath) {
  let text;
  try { text = await fs.promises.readFile(journalPath, 'utf8'); } catch { return; }
  try { await fs.promises.writeFile(journalPath, ''); } catch { /* ignore */ }
  for (const line of text.split(/\r?\n/)) {
    const sibling = line.trim();
    if (!sibling || !path.isAbsolute(sibling)) continue;
    const m = path.basename(sibling).match(RESIZE_SIBLING_RE);
    if (!m) continue;
    try {
      if (!(await fs.promises.lstat(sibling)).isFile()) continue;
      if (!(await fs.promises.lstat(path.join(path.dirname(sibling), m[1]))).isFile()) continue;
      await fs.promises.unlink(sibling);
    } catch { /* missing or locked — leave it */ }
  }
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
      const tmpDir = fs.mkdtempSync(path.join(tempRoot(), 'cbz_resize_'));
      let   tmpCbz = null;

      try {

        const originalSize = fs.statSync(cbzPath).size;

        // 1. Extract EVERYTHING, with paths, into tmpDir.
        //    • `x` keeps the folder tree, so Ch1/001.jpg and Ch2/001.jpg stay
        //      two pages instead of colliding into one flat 001.jpg.
        //    • No include filter: the resized copy replaces the original, so
        //      every entry that is not a page (.jxl, .jfif, .txt, ComicInfo.xml,
        //      empty folders, …) must be carried over unchanged.  The old
        //      image-only filter silently dropped them from the replacement.
        //      A name ending in a space or a period is extracted as "_" and
        //      gets its name back inside the repack (step 6b).  Any other
        //      entry that cannot be extracted as-is on Windows (a file and a
        //      folder with the same name, an unsafe or illegal name that
        //      7-Zip renames) makes this CBZ fail — at 7-Zip here, or at the
        //      step 6 comparison — and the original stays untouched.
        //    • longPath() adds \\?\ so 7-Zip can open CBZs whose full path
        //      exceeds the Windows 260-character MAX_PATH limit.
        //    • 7-Zip exit code 1 = warnings only (e.g. "Unexpected end of
        //      archive" on a truncated file).  We log it and continue with
        //      whatever was extracted — step 6 checks the repack against the
        //      ORIGINAL's own listing, so a short extraction can never become
        //      a replacement.
        try {
          await execFilePromise(
            sevenZip,
            sevenZipArgs('x', [`-o${longPath(tmpDir)}`, '-y'], longPath(cbzPath)),
            signal
          );
        } catch (err) {
          if (err.name === 'AbortError' || signal?.aborted) throw err;
          if (err.code !== 1) throw err; // code 1 = non-fatal warnings — continue
          log(`Archive warning: ${(err.stderr?.trim() || err.message).split('\n')[0]}`, 'warn');
        }

        // 2. Collect the whole tree: pages sorted for correct page order, plus
        //    every other file and every empty folder to carry over.  Paths are
        //    relative to tmpDir; mogrify and 7-Zip both run with cwd=tmpDir.
        const tree     = collectTree(tmpDir);
        const allFiles = tree.images;

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
          const d = await getDimensions(path.join(tmpDir, f));
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
        //    Absolute \\?\ paths: ImageMagick opens a long ABSOLUTE path, but
        //    not a RELATIVE one whose full path (working folder + page path)
        //    passes MAX_PATH — a page in a deeply nested archive failed with
        //    "unable to open image".  A batch ends at BATCH_SIZE pages or before
        //    the command line would pass MAX_CMDLINE characters (Windows allows
        //    32 767), whichever comes first.
        let batch = [], batchLen = 0;
        const runBatch = async () => {
          if (batch.length === 0) return;
          await execFilePromise(
            imageMagick,
            ['mogrify', '-resize', `${MAX_LONG_SIDE}x${MAX_LONG_SIDE}>`, '-quality', String(QUALITY), ...batch],
            signal,
            { cwd: tmpDir }
          );
          batch = []; batchLen = 0;
        };
        for (const rel of oversized) {
          if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
          const page = longPath(path.join(tmpDir, rel));
          if (batch.length >= BATCH_SIZE || (batch.length > 0 && batchLen + page.length + 3 > MAX_CMDLINE)) await runBatch();
          batch.push(page);
          batchLen += page.length + 3;          // the argument plus quotes and a space
        }
        await runBatch();

        // 5. Pack all pages + everything carried over into a new temp CBZ via
        //    7-Zip store mode.  Relative paths keep the original folder tree.
        //    The listfile lives OUTSIDE tmpDir (beside it, same cbz_ prefix
        //    so the startup sweep still removes it after a crash): inside, it
        //    could overwrite an archive entry of the same name, and it would
        //    itself be packed as an entry.
        tmpCbz = path.join(tempRoot(), `cbz_resized_${crypto.randomBytes(6).toString('hex')}.cbz`);
        const listPath    = `${tmpDir}.lst`;
        const packedPaths = [...allFiles, ...tree.others, ...tree.emptyDirs];
        fs.writeFileSync(listPath, listFileContent(packedPaths), 'utf8');
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

        // 6. Validate the new CBZ against the ORIGINAL CBZ itself — not against
        //    what we extracted, which could never see an extraction shortfall
        //    (a page-stripped copy validated and was offered as a replacement).
        //    a) integrity (`7z t`) + the original's own image-entry count;
        //    b) an exact-copy check of both listings: same file paths, same
        //       folders, and the same size + CRC for every entry that was
        //       not resized — so nothing is dropped, renamed or altered.
        // Reading the ORIGINAL for the comparison is its own failure: the
        // end-of-run block says so plainly instead of showing a raw exec error.
        let sourceImageCount, sourceEntries;
        try {
          sourceImageCount = await countImageEntries(longPath(cbzPath), signal);
          sourceEntries    = await listEntries(longPath(cbzPath), signal);
        } catch (err) {
          if (err.name === 'AbortError' || signal?.aborted) throw err;
          err.resizeFailure = {
            message: `"${path.basename(cbzPath)}" can't be read to check the resize against it.`,
            fix: "Check that the file isn't corrupt or in use, then resize it again.",
          };
          throw err;
        }
        // 6b. An entry 7-Zip had to extract under another name (a name ending
        //     in a space or a period: "Vol 1 \001.jpg" lands as
        //     "Vol 1_\001.jpg" — extractedPath) was packed under that name.
        //     Rename it back inside the repack, so the replacement's entry
        //     names are the original's, exactly; the exact-copy check below
        //     then holds the repack to them.  Nothing to do for almost every CBZ.
        const renames = restoreNamePairs(sourceEntries, packedPaths);
        if (renames.length > 0) {
          const rnList = `${tmpDir}.rn.lst`;       // beside tmpDir, like the pack listfile
          fs.writeFileSync(rnList, listFileContent(renames.flat()), 'utf8');
          try {
            await execFilePromise(sevenZip, sevenZipArgs('rn', ['-spd', `@${rnList}`], tmpCbz), signal);
          } finally {
            try { fs.unlinkSync(rnList); } catch {}
          }
        }
        const restored = new Map(renames);
        const changed  = oversized.map((p) => restored.get(p) ?? p);   // resized pages, by their original names
        let { valid, reason } = await validateCbz(tmpCbz, sourceImageCount);
        if (valid) {
          const outputEntries = await listEntries(tmpCbz, signal);
          ({ valid, reason } = compareEntries(sourceEntries, outputEntries, changed));
        }
        if (!valid) {
          log(`Validation failed: ${reason}`, 'error');
          try { await fs.promises.unlink(tmpCbz); } catch {}
          errors.push({ file: cbzPath, reason, message: reason, fix: 'Resize it again.' });
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
        // A failure after packing (e.g. listing the original for its page
        // count) must not leave the unvalidated repack behind.
        if (tmpCbz) try { await fs.promises.unlink(tmpCbz); } catch {}
        const reason = err.stderr?.trim() || err.message;
        log(`ERROR: ${reason}`, 'error');
        // For the end-of-run block: one line of the 7-Zip / ImageMagick
        // output, not all of it (errorLine: the reason, not a bare path).
        errors.push({ file: cbzPath, reason, ...(err.resizeFailure || {
          message: errorLine(err),
          fix: "Resize it again — if it keeps failing, check that the file isn't corrupt, in use, or password-protected.",
        }) });
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
  logResizeFailureSummary(errors, folder, sendLog);

  return { resized, skipped, errors, totalSavedBytes };
}

/**
 * End-of-run failure block (Judy's spec, ruling 15 — the same shape as
 * folder-pack's): a header, then per file `  "<rel>" — <message>` (Open
 * Folder shows the file in Explorer) and `    Fix: <fix>`.  Not shown for a
 * cancelled run (startResize returns before this).
 */
function logResizeFailureSummary(errors, folder, sendLog) {
  if (errors.length === 0) return;
  const n = errors.length;
  sendLog(`${n} ${n === 1 ? 'file' : 'files'} failed to resize:`, 'header');
  for (const e of errors) {
    sendLog(`  "${path.relative(folder, e.file)}" — ${e.message || e.reason}`, 'error',
      { path: e.file, title: 'Show this file in Explorer', mode: 'file' });
    sendLog(`    Fix: ${e.fix || 'Resize it again.'}`, 'info');
  }
}

module.exports = { startResize, replaceWithResized, sweepResizeLeftovers, formatBytes };

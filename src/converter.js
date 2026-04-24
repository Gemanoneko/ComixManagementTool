const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { scanForFiles } = require('./scanner');
const { validateCbz } = require('./validator');
const { buildOutputName } = require('./renamer');
const { getSevenZip, getImageMagick } = require('./tools');

const PDF_DPI = 170;

const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif',
]);

const ARCHIVE_EXTS = new Set(['.cbz', '.cbr', '.rar', '.zip', '.pdf']);

// ─── Utilities ──────────────────────────────────────────────────────────────

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function normaliseName(name) {
  return name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/#.*/g, ' ')
    .replace(/^the\s+/i, '')
    .toLowerCase()
    .replace(/[-–—_.,!?'"]/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function likelyCbzMatches(srcBasename, cbzNames) {
  const srcWords = normaliseName(srcBasename).split(' ').filter(Boolean);
  const srcSet   = new Set(srcWords);
  return cbzNames.filter((cbz) => {
    const cbzWords = normaliseName(path.basename(cbz, '.cbz')).split(' ').filter(Boolean);
    const cbzSet   = new Set(cbzWords);
    let intersection = 0;
    for (const w of srcSet) if (cbzSet.has(w)) intersection++;
    const union = new Set([...srcSet, ...cbzSet]).size;
    return union > 0 && (intersection / union) >= 0.5;
  });
}

function formatEta(ms) {
  const s = Math.round(ms / 1000);
  if (s < 10) return 'a few seconds';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

function execFilePromise(cmd, args, signal, execOpts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { maxBuffer: 1024 * 1024 * 512, ...execOpts },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }));
        else resolve({ stdout, stderr });
      }
    );
    // Run at below-normal priority so games and other foreground apps
    // are never starved by ImageMagick / 7-Zip workers.
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* ignore */ }
    if (signal) {
      const onAbort = () => {
        child.kill();
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cbz_'));
}

async function removeTempDir(dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

/**
 * Returns true if cbzPath exists, can be opened as a ZIP, and contains at
 * least one image entry.  Used to guard skip-if-exists logic so that a CBZ
 * left behind by a crashed/aborted previous run is detected and re-converted
 * instead of silently treated as complete.
 *
 * Uses 7-Zip so that large CBZs (1 GB+) are not loaded into Node.js RAM.
 */
async function canOpenCbz(cbzPath) {
  const sevenZip = getSevenZip();
  if (!sevenZip) return false;
  try {
    // maxBuffer: 64 MB — archives with thousands of entries can produce large listings.
    // Async so the Electron main-process event loop stays responsive.
    const { stdout } = await execFilePromise(sevenZip, ['l', '-slt', cbzPath], null,
      { maxBuffer: 64 * 1024 * 1024 });
    return stdout.split(/\r?\n/).some((line) => {
      if (!line.startsWith('Path = ')) return false;
      const ext = path.extname(line.slice(7).trim()).toLowerCase();
      return IMAGE_EXTS.has(ext);
    });
  } catch {
    return false;
  }
}

// ─── Extraction ─────────────────────────────────────────────────────────────

// Returns an array of filenames that were skipped due to CRC corruption
// (empty array on a clean extraction).  Throws on fatal errors.
async function extractArchive(srcFile, destDir, signal) {
  const sevenZip = getSevenZip();
  if (!sevenZip) throw new Error('7-Zip not found. Install 7-Zip or run "npm run prepare-vendor".');

  try {
    await execFilePromise(sevenZip, ['x', `-o${destDir}`, '-y', '--', srcFile], signal);
  } catch (err) {
    if (err.name === 'AbortError' || signal?.aborted) throw err;

    // 7-Zip exits with code 2 when one or more entries fail the CRC check but
    // the rest of the archive is intact.  Parse the stderr for the affected
    // filenames, delete those (potentially corrupt) extracts, and continue so
    // the remaining pages can still be converted.
    const crcNames = [];
    for (const line of (err.stderr || '').split(/\r?\n/)) {
      const m = line.match(/^(ERROR:\s+)?CRC Failed\s*(?:\(reading\))?\s*:\s*(.+)$/i);
      if (m) crcNames.push(m[2].trim());
    }

    // If there were non-CRC errors too, or no CRC names found, treat as fatal.
    // Only lines that START with "ERROR:" are actual error lines; summary lines
    // like "Sub items Errors: 1" and "Archives with Errors: 1" must be excluded
    // or the nonCrcError check fires on every CRC failure, killing the recovery.
    const nonCrcError = (err.stderr || '').split(/\r?\n/).some(
      (l) => /^error:/i.test(l.trim()) && !/CRC Failed/i.test(l),
    );
    if (nonCrcError || crcNames.length === 0) throw err;

    // Delete the bad extracts so they don't end up in the output CBZ.
    for (const name of crcNames) {
      const full = path.join(destDir, name);
      try { await fs.promises.unlink(full); } catch {}
    }
    return crcNames;
  }

  return []; // clean extraction — no corrupt pages
}

/**
 * Get PDF page count using two methods, fastest first.
 *
 * Method 1 — Parse the PDF file directly (no external tool, instant).
 *   PDF stores /Count N in its page-tree nodes. The root /Pages object
 *   holds the total; intermediate nodes hold subtree counts.
 *   Reading the last 1 MB (where the xref/trailer lives) and taking
 *   max(/Count) reliably gives the total for standard PDFs.
 *
 * Method 2 — ImageMagick identify -ping (fallback, requires GhostScript).
 */
async function getPdfPageCount(pdfPath, signal) {
  // ── Method 1: read PDF structure directly ───────────────────────────────
  // Read both the head (linearization dict has /N pagecount) and the tail
  // (xref/trailer area has /Count pagecount).  Modern PDFs using compressed
  // cross-reference streams (PDF 1.5+) may hide all /Count entries inside
  // zlib blobs, so scanning both ends gives the best plain-text coverage.
  try {
    const stats   = fs.statSync(pdfPath);
    const readLen = Math.min(1024 * 1024, stats.size);
    const fd      = fs.openSync(pdfPath, 'r');
    let text;
    try {
      const tail = Buffer.alloc(readLen);
      fs.readSync(fd, tail, 0, readLen, Math.max(0, stats.size - readLen));
      text = tail.toString('latin1');
      if (stats.size > readLen) {
        const head = Buffer.alloc(readLen);
        fs.readSync(fd, head, 0, readLen, 0);
        text = head.toString('latin1') + text;
      }
    } finally {
      fs.closeSync(fd);
    }

    // Only trust /Count values that appear inside a /Type /Pages dictionary.
    // A bare /Count scan picks up false positives from font dicts, form fields,
    // etc. — those can be larger than the real page count and cause workers to
    // request pages beyond the end of the file.
    const ctxMatches = [
      ...text.matchAll(/\/Type\s*\/Pages[\s\S]{0,400}?\/Count\s+(\d+)/g),
      ...text.matchAll(/\/Count\s+(\d+)[\s\S]{0,400}?\/Type\s*\/Pages/g),
    ];
    if (ctxMatches.length > 0) {
      const total = Math.max(...ctxMatches.map((m) => parseInt(m[1], 10)));
      if (total > 0) return total;
    }
    // No /Type /Pages context found — don't guess from orphaned /Count values.
  } catch { /* fall through */ }

  // ── Method 2: ImageMagick identify -ping ────────────────────────────────
  try {
    const im = getImageMagick();
    if (im) {
      const { stdout } = await execFilePromise(
        im,
        ['identify', '-ping', '-format', '%n\n', pdfPath],
        signal
      );
      // %n = total pages in sequence, reported once per page — first line is enough.
      const n = parseInt(stdout.trim().split('\n')[0], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch { /* give up */ }

  return null;
}

/**
 * Convert all PDF pages to JPEG files in destDir.
 *
 * When totalPages is known the work is split across multiple parallel
 * ImageMagick workers (one per logical CPU, minimum 20 pages each) using
 * page-range syntax `file.pdf[start-end]` with `-scene start` so output
 * files are numbered by their true page index and sort naturally.
 *
 * onPageProgress(doneCount) is called every ~600 ms while conversion runs.
 */
async function extractPdf(srcFile, destDir, totalPages, signal, onPageProgress, log) {
  const imageMagick = getImageMagick();
  if (!imageMagick) throw new Error('ImageMagick not found. Install ImageMagick 7 from imagemagick.org.');

  const baseName   = path.basename(srcFile, path.extname(srcFile));
  const outPattern = path.join(destDir, `${baseName}_%04d.jpg`);

  // -density must come before the input so GhostScript rasterises at the right DPI.
  // -colorspace / -background / -alpha are image operators and must come after the input.
  const preInput  = ['-density', String(PDF_DPI)];
  const postInput = ['-colorspace', 'sRGB', '-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-resize', '4500x4500>'];
  const quality   = ['-quality', '90'];

  // Build one task array per worker
  let tasks;
  if (totalPages && totalPages > 1) {
    const numWorkers = Math.min(
      os.cpus().length,
      Math.max(1, Math.floor(totalPages / 20))
    );
    const chunkSize = Math.ceil(totalPages / numWorkers);
    tasks = [];
    for (let i = 0; i < numWorkers; i++) {
      const start = i * chunkSize;
      if (start >= totalPages) break;
      const end = Math.min(start + chunkSize - 1, totalPages - 1);
      tasks.push([
        ...preInput,
        `${srcFile}[${start}-${end}]`,
        ...postInput,
        '-scene', String(start),
        ...quality,
        outPattern,
      ]);
    }
  } else {
    // Page count unknown — single process over the full file
    tasks = [[...preInput, srcFile, ...postInput, ...quality, outPattern]];
  }

  // Run workers; if any fail, keep what was produced and retry only the missing pages.
  async function runTasks() {
    if (tasks.length === 1) {
      await execFilePromise(imageMagick, tasks[0], signal);
      return;
    }
    const results = await Promise.allSettled(tasks.map((args) => execFilePromise(imageMagick, args, signal)));
    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length === 0) return;
    if (failures.some((r) => r.reason?.name === 'AbortError')) {
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    }

    // Determine which page indices are still missing from the output directory.
    let produced;
    try {
      produced = new Set(
        fs.readdirSync(destDir)
          .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
          .map((f) => { const m = path.basename(f, path.extname(f)).match(/_(\d+)$/); return m ? parseInt(m[1], 10) : -1; })
          .filter((n) => n >= 0)
      );
    } catch { produced = new Set(); }

    const missing = [];
    for (let i = 0; i < totalPages; i++) {
      if (!produced.has(i)) missing.push(i);
    }
    if (missing.length === 0) return;

    log?.(`  ${failures.length} worker(s) failed — retrying ${missing.length} missing page(s) serially…`, 'warn');
    for (const pageIdx of missing) {
      if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      await execFilePromise(imageMagick, [
        ...preInput, `${srcFile}[${pageIdx}]`, ...postInput,
        '-scene', String(pageIdx), ...quality, outPattern,
      ], signal);
    }
  }

  // After runTasks (and its missing-page retry), scan for files that exist but
  // have corrupt/empty content and retry those pages individually.
  async function retryCorrupted() {
    const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);
    let corrupt;
    try {
      corrupt = fs.readdirSync(destDir)
        .filter((f) => /\.jpe?g$/i.test(f))
        .flatMap((f) => {
          const m = path.basename(f, path.extname(f)).match(/_(\d+)$/);
          if (!m) return [];
          const filePath = path.join(destDir, f);
          try {
            const stat = fs.statSync(filePath);
            if (stat.size < 3) return [{ pageIdx: parseInt(m[1], 10), filePath }];
            const buf = Buffer.alloc(3);
            const fd = fs.openSync(filePath, 'r');
            try {
              fs.readSync(fd, buf, 0, 3, 0);
            } finally {
              fs.closeSync(fd);
            }
            if (!buf.equals(JPEG_SIG)) return [{ pageIdx: parseInt(m[1], 10), filePath }];
          } catch { return [{ pageIdx: parseInt(m[1], 10), filePath }]; }
          return [];
        });
    } catch { return; }

    if (corrupt.length === 0) return;
    log?.(`  ${corrupt.length} corrupted page(s) detected — retrying…`, 'warn');
    for (const { pageIdx, filePath } of corrupt) {
      if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      await execFilePromise(imageMagick, [
        ...preInput, `${srcFile}[${pageIdx}]`, ...postInput,
        '-scene', String(pageIdx), ...quality, outPattern,
      ], signal);
    }
  }

  if (!onPageProgress) {
    await runTasks();
    await retryCorrupted();
    return;
  }

  // Poll the output directory for new JPEG files while workers run in parallel
  let polling = true;
  const pollLoop = async () => {
    while (polling) {
      await new Promise((r) => setTimeout(r, 600));
      if (!polling) break;
      try {
        const count = fs.readdirSync(destDir)
          .filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).length;
        if (count > 0) onPageProgress(count);
      } catch { /* dir may not exist yet */ }
    }
  };

  const pollPromise = pollLoop();
  try {
    await runTasks();
  } finally {
    polling = false;
    await pollPromise;
  }
  await retryCorrupted();
}

// ─── Structure analysis ──────────────────────────────────────────────────────

/** Collect all image files directly inside dir (non-recursive). */
function shallowImages(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name))
    .sort((a, b) => naturalSort(path.basename(a), path.basename(b)));
}

/** Collect all .xml files directly inside dir (non-recursive). */
function shallowXml(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.xml')
    .map((e) => path.join(dir, e.name));
}

/** Collect all .xml files under dir, recursively. */
function deepXml(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...deepXml(full));
    else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.xml') results.push(full);
  }
  return results;
}

/** Collect ALL image files under dir, recursively. */
function deepImages(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...deepImages(full));
    } else if (entry.isFile() && IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results.sort((a, b) => naturalSort(a, b));
}

/** Top-level entries of dir: { loose: string[], subdirs: {name,dir}[] } */
function topLevelStructure(dir) {
  const loose = [];
  const subdirs = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      subdirs.push({ name: entry.name, dir: full });
    } else if (IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      loose.push(full);
    }
  }
  loose.sort((a, b) => naturalSort(path.basename(a), path.basename(b)));
  subdirs.sort((a, b) => naturalSort(a.name, b.name));
  return { loose, subdirs };
}

/**
 * Decide how to split the extracted content into output groups.
 *
 * Returns an array of { name, files, parentName, isSplit }
 *   name        – proposed output base name
 *   files       – image files to pack
 *   parentName  – context for generic-name resolution
 *   isSplit     – true when this group came from a subdir
 */
function buildGroups(tmpDir, archiveBaseName, archiveParentDir) {
  const { loose, subdirs } = topLevelStructure(tmpDir);

  // Helper: merge images + XML from a dir, keeping images for count tracking
  function mergeWithXml(images, xmlFiles) {
    return [...images, ...xmlFiles];
  }

  // Case A: no subdirs → single flat archive
  if (subdirs.length === 0) {
    const images = shallowImages(tmpDir);
    if (images.length === 0) return [];
    const files = mergeWithXml(images, shallowXml(tmpDir));
    return [{ name: archiveBaseName, files, imageCount: images.length, parentName: archiveParentDir, isSplit: false }];
  }

  // Case B: exactly one subdir, no loose files
  //   If the subdir name matches the archive name it's just a wrapper folder → treat as flat.
  if (subdirs.length === 1 && loose.length === 0) {
    const sub = subdirs[0];
    const subNorm = sub.name.toLowerCase().replace(/[_\s-]/g, '');
    const archNorm = archiveBaseName.toLowerCase().replace(/[_\s-]/g, '');
    if (subNorm === archNorm) {
      // Wrapper folder — look inside before deciding
      const inner = topLevelStructure(sub.dir);
      if (inner.subdirs.length > 0) {
        // Wrapper contains subdirs (e.g. chapters) — one CBZ per inner subdir to
        // avoid filename collisions when pages are numbered per-chapter (001, 002…)
        const groups = [];
        for (const innerSub of inner.subdirs) {
          const images = deepImages(innerSub.dir);
          if (images.length > 0) {
            const files = mergeWithXml(images, deepXml(innerSub.dir));
            groups.push({ name: innerSub.name, files, imageCount: images.length, parentName: archiveBaseName, isSplit: true });
          }
        }
        if (inner.loose.length > 0) {
          const xmlAtRoot = shallowXml(sub.dir);
          const files = mergeWithXml(inner.loose, xmlAtRoot);
          groups.push({ name: archiveBaseName, files, imageCount: inner.loose.length, parentName: archiveParentDir, isSplit: false });
        }
        if (groups.length > 0) return groups;
      }
      // Truly flat inside the wrapper — single CBZ named after the archive
      const images = deepImages(sub.dir);
      if (images.length === 0) return [];
      const files = mergeWithXml(images, deepXml(sub.dir));
      return [{ name: archiveBaseName, files, imageCount: images.length, parentName: archiveParentDir, isSplit: false }];
    }
    // Genuine single subdir (e.g. only "Chapter 01" inside)
    const images = deepImages(sub.dir);
    if (images.length === 0) return [];
    const files = mergeWithXml(images, deepXml(sub.dir));
    return [{ name: sub.name, files, imageCount: images.length, parentName: archiveBaseName, isSplit: true }];
  }

  // Case C: multiple subdirs → one CBZ per subdir + one for loose files
  const groups = [];
  for (const sub of subdirs) {
    const images = deepImages(sub.dir);
    if (images.length > 0) {
      const files = mergeWithXml(images, deepXml(sub.dir));
      groups.push({ name: sub.name, files, imageCount: images.length, parentName: archiveBaseName, isSplit: true });
    }
  }
  if (loose.length > 0) {
    // Loose files at root get their own CBZ named after the archive
    const xmlAtRoot = shallowXml(tmpDir);
    const files = mergeWithXml(loose, xmlAtRoot);
    groups.push({ name: archiveBaseName, files, imageCount: loose.length, parentName: archiveParentDir, isSplit: false });
  }
  return groups;
}

// ─── Hierarchical archive support ────────────────────────────────────────────

/**
 * After extraction, step inside a single same-name wrapper folder if present
 * (e.g. Archive.zip → Archive\ → actual content).
 * buildGroups handles this too, but we need it earlier for the complex-structure check.
 */
function getEffectiveContentDir(extractedDir, archiveBaseName) {
  let entries;
  try { entries = fs.readdirSync(extractedDir, { withFileTypes: true }); } catch { return extractedDir; }
  const subdirs = entries.filter((e) => e.isDirectory());
  const files   = entries.filter((e) => e.isFile());
  if (subdirs.length === 1 && files.length === 0) {
    const subNorm  = subdirs[0].name.toLowerCase().replace(/[_\s-]/g, '');
    const archNorm = archiveBaseName.toLowerCase().replace(/[_\s-]/g, '');
    if (subNorm === archNorm) return path.join(extractedDir, subdirs[0].name);
  }
  return extractedDir;
}

/**
 * Returns true when the extracted content needs hierarchical processing:
 *   - archive files exist at the top level, OR
 *   - any immediate subdir itself has subdirs or archives.
 *
 * Simple structures (flat images, or top-level subdirs with images only) return
 * false and are handled by buildGroups as before (no output wrapper folder).
 */
function isComplexStructure(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }

  if (entries.some((e) => e.isFile() && ARCHIVE_EXTS.has(path.extname(e.name).toLowerCase()))) return true;

  for (const e of entries.filter((e) => e.isDirectory())) {
    let sub;
    try { sub = fs.readdirSync(path.join(dir, e.name), { withFileTypes: true }); } catch { continue; }
    if (sub.some((se) => se.isDirectory())) return true;
    if (sub.some((se) => se.isFile() && ARCHIVE_EXTS.has(path.extname(se.name).toLowerCase()))) return true;
  }
  return false;
}

/**
 * Recursively process srcDir contents into outDir:
 *   Archive files  → copy (CBZ) or convert (other) into outDir
 *   Leaf image dir → pack all images to outDir/<folderName>.cbz
 *   Non-leaf dir   → mkdir outDir/<name>, recurse
 *   Loose images   → pack to outDir/<path.basename(outDir)>.cbz
 */
async function processDirectoryTree(srcDir, outDir, isManga, log, signal, waitIfPaused = null) {
  let entries;
  try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return []; }

  const subdirs  = entries.filter((e) => e.isDirectory()).sort((a, b) => naturalSort(a.name, b.name));
  const images   = entries
    .filter((e) => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(srcDir, e.name))
    .sort((a, b) => naturalSort(path.basename(a), path.basename(b)));
  const archives = entries
    .filter((e) => e.isFile() && ARCHIVE_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(srcDir, e.name))
    .sort((a, b) => naturalSort(path.basename(a), path.basename(b)));

  const outputs = [];

  // ── Archive files at this level ─────────────────────────────────────────
  for (const archive of archives) {
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const ext  = path.extname(archive).toLowerCase();
    const base = path.basename(archive);
    if (ext === '.cbz') {
      const dst = path.join(outDir, base);
      if (fs.existsSync(dst)) {
        log(`  SKIP (exists): ${base}`, 'skip');
      } else {
        await fs.promises.copyFile(archive, dst);
        log(`  Copied: ${base}`, 'success');
        outputs.push(dst);
      }
    } else {
      log(`  Converting: ${base}`, 'info');
      const result = await processFile(archive, isManga, log, signal, outDir, waitIfPaused);
      if (result.success && result.outputs) outputs.push(...result.outputs);
    }
  }

  // ── Subdirectories ──────────────────────────────────────────────────────
  for (const sub of subdirs) {
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const subSrc = path.join(srcDir, sub.name);

    let subEntries;
    try { subEntries = fs.readdirSync(subSrc, { withFileTypes: true }); } catch { continue; }

    const subImages      = subEntries
      .filter((e) => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(subSrc, e.name))
      .sort((a, b) => naturalSort(path.basename(a), path.basename(b)));
    const subHasSubdirs  = subEntries.some((e) => e.isDirectory());
    const subHasArchives = subEntries.some((e) => e.isFile() && ARCHIVE_EXTS.has(path.extname(e.name).toLowerCase()));

    if (!subHasSubdirs && !subHasArchives && subImages.length > 0) {
      // Leaf image folder → pack to CBZ at this output level
      const cbzPath = path.join(outDir, `${sub.name}.cbz`);
      if (fs.existsSync(cbzPath) && !(await canOpenCbz(cbzPath))) {
        log(`  WARN: Existing ${sub.name}.cbz is unreadable — re-converting…`, 'warn');
        try { fs.unlinkSync(cbzPath); } catch { /* ignore */ }
      }
      if (fs.existsSync(cbzPath)) {
        log(`  SKIP (exists): ${sub.name}.cbz`, 'skip');
      } else {
        const subXml    = subEntries
          .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.xml')
          .map((e) => path.join(subSrc, e.name));
        const subToPack = [...subImages, ...subXml];
        log(`  Packing → ${sub.name}.cbz  (${subImages.length} images)`, 'info');
        const tmpPath = await packToCbz(subToPack, cbzPath, signal);
        const v = await validateCbz(tmpPath, subImages.length);
        if (v.valid) {
          // Validation passed — promote the .tmp to the final .cbz atomically.
          await fs.promises.rename(tmpPath, cbzPath);
          log(`  ✓ Valid: ${sub.name}.cbz`, 'success');
          outputs.push(cbzPath);
        } else {
          log(`  ERROR: ${v.reason}`, 'error');
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        }
      }
    } else {
      // Intermediate folder — create matching output subdir and recurse
      const subOut = path.join(outDir, sub.name);
      fs.mkdirSync(subOut, { recursive: true });
      const subOutputs = await processDirectoryTree(subSrc, subOut, isManga, log, signal, waitIfPaused);
      outputs.push(...subOutputs);
    }
  }

  // ── Loose images alongside subdirs or archives ──────────────────────────
  if (images.length > 0) {
    const looseName  = path.basename(outDir);
    const cbzPath    = path.join(outDir, `${looseName}.cbz`);
    if (fs.existsSync(cbzPath) && !(await canOpenCbz(cbzPath))) {
      log(`  WARN: Existing ${looseName}.cbz is unreadable — re-converting…`, 'warn');
      try { fs.unlinkSync(cbzPath); } catch { /* ignore */ }
    }
    if (fs.existsSync(cbzPath)) {
      log(`  SKIP (exists): ${looseName}.cbz`, 'skip');
    } else {
      const looseXml  = entries
        .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.xml')
        .map((e) => path.join(srcDir, e.name));
      const toPack = [...images, ...looseXml];
      log(`  Packing loose images → ${looseName}.cbz  (${images.length} images)`, 'info');
      const tmpPath = await packToCbz(toPack, cbzPath, signal);
      const v = await validateCbz(tmpPath, images.length);
      if (v.valid) {
        // Validation passed — promote the .tmp to the final .cbz atomically.
        await fs.promises.rename(tmpPath, cbzPath);
        log(`  ✓ Valid: ${looseName}.cbz`, 'success');
        outputs.push(cbzPath);
      } else {
        log(`  ERROR: ${v.reason}`, 'error');
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    }
  }

  return outputs;
}

// ─── Packing ────────────────────────────────────────────────────────────────

/**
 * Pack an array of image file paths into a CBZ (flat ZIP, no internal folder).
 * Uses 7-Zip in store mode so images are never loaded into Node.js RAM.
 * Image files are stored with natural-sort ordering by filename.
 *
 * Packs to `<outputPath>.tmp` — caller is responsible for validating and then
 * fs.rename-ing the .tmp to the final outputPath. This makes the on-disk state
 * self-describing: a final .cbz exists only if validation passed. A crash or
 * abort leaves an orphan .cbz.tmp (never matched by the .cbz extension filters)
 * that the next run ignores, so the source is safely re-processed.
 *
 * Returns the tmp path that was written.
 */
async function packToCbz(imageFiles, outputPath, signal) {
  const sevenZip = getSevenZip();
  // All files in a single pack call are in the same directory (CBZ is flat).
  const srcDir   = path.dirname(imageFiles[0]);
  const basenames = imageFiles.map((f) => path.basename(f));
  // List file lives inside the temp dir (srcDir is always inside cbz_* tmpDir)
  // so it is auto-removed by removeTempDir and by the startup orphan cleanup.
  const listPath = path.join(srcDir, '.cbzpack.lst');
  const tmpOutputPath = outputPath + '.tmp';
  fs.writeFileSync(listPath, basenames.join('\n'), 'utf8');
  // If a stale .tmp already exists from a prior crash/abort, remove it so
  // 7-Zip doesn't try to append to it (it creates-or-updates by default).
  try { fs.unlinkSync(tmpOutputPath); } catch { /* ignore — may not exist */ }
  try {
    // -tzip: ZIP container  -mx=0: store (images are already compressed)
    // cwd=srcDir: 7-Zip adds files by basename → no directory prefix in archive
    await execFilePromise(
      sevenZip,
      ['a', '-tzip', '-mx=0', tmpOutputPath, `@${listPath}`],
      signal,
      { cwd: srcDir },
    );
  } catch (err) {
    // Delete any partial .tmp so it doesn't linger as a stale orphan.
    try { fs.unlinkSync(tmpOutputPath); } catch { /* ignore — may not exist yet */ }
    throw err;
  } finally {
    try { fs.unlinkSync(listPath); } catch { /* ignore */ }
  }
  return tmpOutputPath;
}

// ─── Core per-file processor ─────────────────────────────────────────────────

// outputDir is used when processing nested archives so outputs land next to the outer archive.
async function processFile(srcFile, isManga, log, signal, outputDir = null, waitIfPaused = null) {
  const ext    = path.extname(srcFile).toLowerCase();
  const srcDir = path.dirname(srcFile);
  const outDir = outputDir ?? srcDir;
  const baseName = path.basename(srcFile, path.extname(srcFile));
  const isPdf = ext === '.pdf';
  let pdfPages = null;

  const tmpDir = makeTempDir();

  try {
    // 1. Extract
    if (ext === '.pdf') {
      const pdfStart = Date.now();
      log(`  Converting PDF pages to JPEG at ${PDF_DPI} DPI…`, 'info');

      // Tick elapsed seconds so the user can see the app is alive while we
      // query page count and wait for the first JPEG to appear.
      let elapsedTick = setInterval(() => {
        const s = Math.round((Date.now() - pdfStart) / 1000);
        log(`  Converting PDF pages to JPEG at ${PDF_DPI} DPI… (${s}s elapsed)`, 'info', true);
      }, 1000);

      try {
        // Fast metadata-only query — no rendering
        const totalPages = await getPdfPageCount(srcFile, signal);

        // As soon as we know the page count, show it so the user isn't staring
        // at a bare elapsed timer while GhostScript renders the first chunk.
        if (totalPages) {
          clearInterval(elapsedTick);
          elapsedTick = null;
          log(`  Converting PDF pages to JPEG at ${PDF_DPI} DPI… (0 / ${totalPages} pages — initializing…)`, 'info', true);
        }

        let firstPageSeen = false;

        const onPageProgress = (done) => {
          if (!firstPageSeen) {
            // Switch from elapsed-time mode to page-progress mode
            firstPageSeen = true;
            clearInterval(elapsedTick);
            elapsedTick = null;
          }
          const elapsed = Date.now() - pdfStart;
          const avgMs   = elapsed / done;
          // If done exceeds totalPages the count was wrong (compressed PDF streams);
          // fall back to "X pages done" so we never show "7 / 1 pages".
          const knownTotal = totalPages && done <= totalPages ? totalPages : null;
          let msg = `  Converting PDF pages to JPEG at ${PDF_DPI} DPI… (${done}`;
          if (knownTotal) {
            msg += ` / ${knownTotal} pages`;
            if (done < knownTotal) msg += ` — ETA: ${formatEta(avgMs * (knownTotal - done))}`;
          } else {
            msg += ' pages done';
          }
          msg += ')';
          log(msg, 'info', true);
        };

        await extractPdf(srcFile, tmpDir, totalPages, signal, onPageProgress, log);

        const finalCount = fs.readdirSync(tmpDir)
          .filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).length;
        pdfPages = finalCount;
        const countNote = (totalPages && finalCount !== totalPages)
          ? ` (estimated ${totalPages}, actual ${finalCount})`
          : '';
        log(`  PDF extracted: ${finalCount} pages at ${PDF_DPI} DPI${countNote}`, 'info', true);
      } finally {
        clearInterval(elapsedTick);
        elapsedTick = null;
      }
    } else {
      log('  Extracting archive…', 'info');
      const corruptPages = await extractArchive(srcFile, tmpDir, signal);
      if (corruptPages.length > 0) {
        log(`  WARNING: ${corruptPages.length} page(s) had CRC errors and were skipped: ${corruptPages.join(', ')}`, 'warn');
      }
    }

    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

    // Pause checkpoint — extraction can take minutes for large archives.
    // Checking here (after extract, before pack) means pause takes effect
    // as soon as the current extract step finishes rather than waiting for
    // the entire file including packing and validation to complete.
    if (waitIfPaused) await waitIfPaused(signal);

    // 2. Determine structure type and route accordingly.
    //    Complex (archives at any level, or subdirs containing further subdirs):
    //      → create a named output folder and recurse with processDirectoryTree.
    //    Simple (flat images, single-name wrapper, or top-level image-only subdirs):
    //      → buildGroups handles it exactly as before (no output wrapper folder).
    const contentDir = getEffectiveContentDir(tmpDir, baseName);

    if (isComplexStructure(contentDir)) {
      const wrapperOutDir = path.join(outDir, baseName);
      fs.mkdirSync(wrapperOutDir, { recursive: true });
      log(`  Hierarchical structure — processing into ${baseName}/`, 'info');
      const outputs = await processDirectoryTree(contentDir, wrapperOutDir, isManga, log, signal, waitIfPaused);
      if (outputs.length === 0) {
        log('  WARNING: No output produced from hierarchical archive', 'warn');
        return { success: false, outcome: 'noImages', isPdf, pdfPages };
      }
      return { success: true, outcome: 'hierarchical', outputs, folderName: baseName, isPdf, pdfPages };
    }

    // 3. Simple structure → image / folder packing
    const archiveParentDir = path.basename(srcDir);
    const groups = buildGroups(tmpDir, baseName, archiveParentDir);

    if (groups.length === 0) {
      log('  WARNING: No images found inside archive', 'warn');
      return { success: false, outcome: 'noImages', isPdf, pdfPages };
    }

    // Multi-output → place CBZs inside a named subfolder to keep root clean.
    // Single-output stays flat alongside the original archive.
    let groupOutDir = outDir;
    if (groups.length > 1) {
      groupOutDir = path.join(outDir, baseName);
      fs.mkdirSync(groupOutDir, { recursive: true });
      log(`  Split into ${groups.length} archives → ${baseName}\\`, 'info');
    }

    // 4. Create a CBZ for each group
    const outputs = [];

    for (const group of groups) {
      if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

      const outputName = buildOutputName(group.name, group.parentName, isManga, group.isSplit);
      const outputPath = path.join(groupOutDir, outputName + '.cbz');

      if (fs.existsSync(outputPath)) {
        if (await canOpenCbz(outputPath)) {
          log(`  SKIP (exists): ${outputName}.cbz`, 'skip');
          continue;
        }
        log(`  WARN: Existing ${outputName}.cbz is unreadable — re-converting…`, 'warn');
        try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
      }

      const imageCount = group.imageCount ?? group.files.length;
      log(`  Packing → ${outputName}.cbz  (${imageCount} images)`, 'info');
      const tmpPath = await packToCbz(group.files, outputPath, signal);

      // 5. Validate the .tmp; only on success do we rename to the final .cbz.
      //    An abort or crash between pack and rename leaves an orphan .cbz.tmp
      //    (never matched by .cbz extension filters) so the source is safely
      //    re-processed on the next run and never eligible for deletion.
      const validation = await validateCbz(tmpPath, imageCount);
      if (!validation.valid) {
        log(`  ERROR: Validation failed — ${validation.reason}`, 'error');
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        return { success: false, outcome: 'validationFailed', reason: validation.reason, isPdf, pdfPages };
      }

      await fs.promises.rename(tmpPath, outputPath);
      log(`  ✓ Valid: ${outputName}.cbz`, 'success');
      outputs.push(outputPath);
    }

    const outcome    = outputs.length === 0 ? 'allSkipped'
      : outputs.length === 1 ? 'single' : 'multi';
    const folderName = groups.length > 1 ? baseName : null;
    return { success: outputs.length > 0, outcome, outputs, folderName, isPdf, pdfPages };

  } finally {
    await removeTempDir(tmpDir);
  }
}


// ─── Orphan detection ────────────────────────────────────────────────────────

const CONVERTIBLE_EXTS = new Set(['.cbr', '.rar', '.zip', '.pdf']);

/**
 * Walk rootDir and find source files (.cbr/.rar/.zip/.pdf) that already have
 * a matching .cbz in the same folder (same base name, same directory).
 * These are left-over originals from previous runs where deletion was skipped.
 *
 * Returns { simple: string[], needsReview: string[] }
 *   simple      – exact base-name match (safe to offer for deletion)
 *   needsReview – convertible files whose .cbz counterpart doesn't exist by name
 *                 but the folder also contains .cbz files (possible collection/split leftovers)
 */
async function findOrphanedOriginals(rootDir) {
  const simple      = [];
  const needsReview = [];

  // Normalise a filename stem for pre-existing match: lowercase, ensure a space
  // between adjacent parenthetical groups, collapse whitespace runs.
  // "Batman (2023)(Digital Rip)" → "batman (2023) (digital rip)"
  const normaliseForMatch = (s) =>
    s.toLowerCase().replace(/\)\s*\(/g, ') (').replace(/\s+/g, ' ').trim();

  async function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    // Collect files in this directory by extension.
    // cbzByNorm maps a normalised stem → actual CBZ filename, so we can find the
    // real file even when casing or spacing differs (e.g. "(Rip)(DCP)" vs "(Rip) (DCP)").
    const byExt = { src: [], cbzNames: [], cbzByNorm: new Map() };
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (ext === '.cbz') {
        byExt.cbzNames.push(e.name);
        byExt.cbzByNorm.set(normaliseForMatch(path.basename(e.name, '.cbz')), e.name);
      } else if (CONVERTIBLE_EXTS.has(ext)) {
        byExt.src.push(e.name);
      }
    }

    for (const name of byExt.src) {
      const base    = normaliseForMatch(path.basename(name, path.extname(name)));
      const full    = path.join(dir, name);
      const cbzName = byExt.cbzByNorm.get(base); // actual CBZ filename (may differ in spacing)
      if (cbzName) {
        // Normalised match: source + matching CBZ → safe to flag only if CBZ is readable
        const cbzPath = path.join(dir, cbzName);
        if (!(await canOpenCbz(cbzPath))) continue; // corrupted CBZ — leave both files alone
        simple.push(full);
      } else if (byExt.cbzNames.length > 0) {
        // CBZ files exist in this folder but no normalised match →
        // could be a collection archive or split archive that wasn't cleaned up
        needsReview.push({
          file: full,
          nearbyCbzs:    byExt.cbzNames.slice(),
          likelyMatches: likelyCbzMatches(path.basename(name, path.extname(name)), byExt.cbzNames),
        });
      }
    }

    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name));
    }
  }

  await walk(rootDir);
  return { simple, needsReview };
}

// ─── Conversion summary ──────────────────────────────────────────────────────

function logSummary(outcomes, rootFolder, log) {
  if (outcomes.length === 0) return;
  log('\n── Conversion Summary ───────────────────────────────────', 'header');
  for (const { file, result, error } of outcomes) {
    const rel    = path.relative(rootFolder, file);
    const { outcome, outputs = [], folderName, reason, isPdf, pdfPages } = result || {};
    const pdfTag = isPdf && pdfPages ? `  [PDF · ${pdfPages} pages]` : '';

    if (error) {
      log(`  ✗  ${rel}  →  ERROR: ${error}`, 'error');
      continue;
    }

    switch (outcome) {
      case 'single':
        log(`  ✓  ${rel}  →  ${path.basename(outputs[0])}${pdfTag}`, 'success');
        break;
      case 'multi': {
        const names   = outputs.map((o) => path.basename(o, '.cbz'));
        const preview = names.length <= 3
          ? names.join(', ')
          : `${names.slice(0, 2).join(', ')}, … +${names.length - 2} more`;
        const loc = folderName ? ` in ${folderName}\\` : '';
        log(`  ✓  ${rel}  →  ${outputs.length} CBZs${loc}: ${preview}${pdfTag}`, 'success');
        break;
      }
      case 'hierarchical':
        log(`  ✓  ${rel}  →  ${outputs.length} CBZs in ${folderName}\\${pdfTag}`, 'success');
        break;
      case 'allSkipped':
        log(`  →  ${rel}  →  skipped (CBZ already exists)`, 'skip');
        break;
      case 'validationFailed':
        log(`  ✗  ${rel}  →  validation failed — ${reason}`, 'error');
        break;
      case 'noImages':
        log(`  ✗  ${rel}  →  no images found`, 'error');
        break;
      default:
        log(`  ✗  ${rel}  →  failed`, 'error');
    }
  }
}

// ─── Main entry point ────────────────────────────────────────────────────────

async function startConversion(options, log, progress, signal, waitIfPaused) {
  const { rootFolder, isManga } = options;

  log(`Scanning: ${rootFolder}`, 'header');

  const files = await scanForFiles(rootFolder);

  if (files.length === 0) {
    log('No convertible files found (.cbr, .rar, .zip, .pdf).', 'info');
    return { converted: [], preExisting: [], needsReview: [] };
  }

  log(`Found ${files.length} file(s) to convert.\n`, 'info');

  const converted     = []; // converted successfully in this run
  const fileDurations = [];
  const outcomes      = []; // per-file outcome for summary
  let   totalCbzBytes = 0;  // total size of CBZ files created this session

  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) break;

    // Block here while paused; AbortError breaks the loop gracefully
    if (waitIfPaused) {
      try { await waitIfPaused(signal); } catch (err) {
        if (err.name === 'AbortError') break;
        throw err;
      }
    }
    if (signal?.aborted) break;

    const file = files[i];
    const fileStart = Date.now();
    log(`[${i + 1}/${files.length}] ${path.relative(rootFolder, file)}`, 'header');

    try {
      const result = await processFile(file, isManga, log, signal, null, waitIfPaused);
      if (result.success) {
        converted.push(file);
        for (const cbzPath of (result.outputs || [])) {
          try { totalCbzBytes += fs.statSync(cbzPath).size; } catch {}
        }
      }
      outcomes.push({ file, result });
    } catch (err) {
      if (err.name === 'AbortError') break;
      log(`  ERROR: ${err.message}`, 'error');
      outcomes.push({ file, error: err.message });
    }

    fileDurations.push(Date.now() - fileStart);
    const sample = fileDurations.slice(-10);
    const avgMs  = sample.reduce((a, b) => a + b, 0) / sample.length;
    progress(i + 1, files.length, avgMs * (files.length - i - 1));
  }

  progress(files.length, files.length, 0);
  const summary = signal?.aborted
    ? `\nStopped. ${converted.length} file(s) converted before cancel.`
    : `\nDone. ${converted.length} of ${files.length} file(s) converted successfully.`;
  log(summary, converted.length > 0 ? 'success' : 'info');

  if (!signal?.aborted) {
    logSummary(outcomes, rootFolder, log);
  }

  // Post-scan: find pre-existing orphaned originals (from previous runs)
  const { simple: preExisting, needsReview } = await findOrphanedOriginals(rootFolder);

  // Remove files already in 'converted' from preExisting (avoid duplicates)
  const convertedSet  = new Set(converted);
  const uniquePreExisting = preExisting.filter((f) => !convertedSet.has(f));

  if (uniquePreExisting.length > 0) {
    log(`\nFound ${uniquePreExisting.length} pre-existing original(s) with a matching .cbz already present.`, 'warn');
  }
  if (needsReview.length > 0) {
    log(`Found ${needsReview.length} file(s) that may be collection/split-archive leftovers — review manually.`, 'warn');
    for (const item of needsReview) log(`  ? ${path.relative(rootFolder, item.file)}`, 'skip');
  }

  return { converted, preExisting: uniquePreExisting, needsReview, totalCbzBytes };
}

async function convertSingleFile(filePath, isManga, log, signal, waitIfPaused = null) {
  return processFile(filePath, isManga, log, signal, null, waitIfPaused);
}

module.exports = { startConversion, convertSingleFile };

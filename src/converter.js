const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');
const { scanForFiles } = require('./scanner');
const { validateCbz } = require('./validator');
const { buildOutputName } = require('./renamer');
const { getSevenZip, getImageMagick } = require('./tools');

const PDF_DPI = 200;

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

function execFilePromise(cmd, args, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { maxBuffer: 1024 * 1024 * 512 },
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

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

/**
 * Returns true if cbzPath exists, can be opened as a ZIP, and contains at
 * least one image entry.  Used to guard skip-if-exists logic so that a CBZ
 * left behind by a crashed/aborted previous run is detected and re-converted
 * instead of silently treated as complete.
 */
function canOpenCbz(cbzPath) {
  try {
    const zip = new AdmZip(cbzPath);
    return zip.getEntries().some(
      (e) => !e.isDirectory && IMAGE_EXTS.has(path.extname(e.entryName).toLowerCase())
    );
  } catch {
    return false;
  }
}

// ─── Extraction ─────────────────────────────────────────────────────────────

async function extractArchive(srcFile, destDir, signal) {
  const sevenZip = getSevenZip();
  if (!sevenZip) throw new Error('7-Zip not found. Install 7-Zip or run "npm run prepare-vendor".');
  await execFilePromise(sevenZip, ['x', `-o${destDir}`, '-y', '--', srcFile], signal);
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

    const tail = Buffer.alloc(readLen);
    fs.readSync(fd, tail, 0, readLen, Math.max(0, stats.size - readLen));
    let text = tail.toString('latin1');

    if (stats.size > readLen) {
      const head = Buffer.alloc(readLen);
      fs.readSync(fd, head, 0, readLen, 0);
      text = head.toString('latin1') + text;
    }
    fs.closeSync(fd);

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
  const postInput = ['-colorspace', 'sRGB', '-background', 'white', '-alpha', 'remove', '-alpha', 'off'];
  const quality   = ['-quality', '92'];

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

  // Run workers, then fall back to serial if any chunk reported pages-out-of-range.
  // Uses allSettled so all workers complete before we decide whether to retry.
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
    // Page count was wrong — clear any partial output and retry as one serial process
    log?.(`  Page count estimate was wrong (estimated ${totalPages}) — retrying as single process…`, 'warn');
    try {
      for (const f of fs.readdirSync(destDir).filter((f) => /\.(jpg|jpeg|png)$/i.test(f))) {
        try { fs.unlinkSync(path.join(destDir, f)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    await execFilePromise(imageMagick, [...preInput, srcFile, ...postInput, ...quality, outPattern], signal);
  }

  if (!onPageProgress) {
    await runTasks();
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

  // Case A: no subdirs → single flat archive
  if (subdirs.length === 0) {
    const files = shallowImages(tmpDir);
    if (files.length === 0) return [];
    return [{ name: archiveBaseName, files, parentName: archiveParentDir, isSplit: false }];
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
          const files = deepImages(innerSub.dir);
          if (files.length > 0) {
            groups.push({ name: innerSub.name, files, parentName: archiveBaseName, isSplit: true });
          }
        }
        if (inner.loose.length > 0) {
          groups.push({ name: archiveBaseName, files: inner.loose, parentName: archiveParentDir, isSplit: false });
        }
        if (groups.length > 0) return groups;
      }
      // Truly flat inside the wrapper — single CBZ named after the archive
      const files = deepImages(sub.dir);
      if (files.length === 0) return [];
      return [{ name: archiveBaseName, files, parentName: archiveParentDir, isSplit: false }];
    }
    // Genuine single subdir (e.g. only "Chapter 01" inside)
    const files = deepImages(sub.dir);
    if (files.length === 0) return [];
    return [{ name: sub.name, files, parentName: archiveBaseName, isSplit: true }];
  }

  // Case C: multiple subdirs → one CBZ per subdir + one for loose files
  const groups = [];
  for (const sub of subdirs) {
    const files = deepImages(sub.dir);
    if (files.length > 0) {
      groups.push({ name: sub.name, files, parentName: archiveBaseName, isSplit: true });
    }
  }
  if (loose.length > 0) {
    // Loose files at root get their own CBZ named after the archive
    groups.push({ name: archiveBaseName, files: loose, parentName: archiveParentDir, isSplit: false });
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
async function processDirectoryTree(srcDir, outDir, isManga, log, signal) {
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
        fs.copyFileSync(archive, dst);
        log(`  Copied: ${base}`, 'success');
        outputs.push(dst);
      }
    } else {
      log(`  Converting: ${base}`, 'info');
      const result = await processFile(archive, isManga, log, signal, outDir);
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
      if (fs.existsSync(cbzPath) && !canOpenCbz(cbzPath)) {
        log(`  WARN: Existing ${sub.name}.cbz is unreadable — re-converting…`, 'warn');
        try { fs.unlinkSync(cbzPath); } catch { /* ignore */ }
      }
      if (fs.existsSync(cbzPath)) {
        log(`  SKIP (exists): ${sub.name}.cbz`, 'skip');
      } else {
        log(`  Packing → ${sub.name}.cbz  (${subImages.length} images)`, 'info');
        packToCbz(subImages, cbzPath);
        const v = validateCbz(cbzPath, subImages.length);
        if (v.valid) {
          log(`  ✓ Valid: ${sub.name}.cbz`, 'success');
          outputs.push(cbzPath);
        } else {
          log(`  ERROR: ${v.reason}`, 'error');
          try { fs.unlinkSync(cbzPath); } catch { /* ignore */ }
        }
      }
    } else {
      // Intermediate folder — create matching output subdir and recurse
      const subOut = path.join(outDir, sub.name);
      fs.mkdirSync(subOut, { recursive: true });
      const subOutputs = await processDirectoryTree(subSrc, subOut, isManga, log, signal);
      outputs.push(...subOutputs);
    }
  }

  // ── Loose images alongside subdirs or archives ──────────────────────────
  if (images.length > 0) {
    const looseName = path.basename(outDir);
    const cbzPath   = path.join(outDir, `${looseName}.cbz`);
    if (fs.existsSync(cbzPath) && !canOpenCbz(cbzPath)) {
      log(`  WARN: Existing ${looseName}.cbz is unreadable — re-converting…`, 'warn');
      try { fs.unlinkSync(cbzPath); } catch { /* ignore */ }
    }
    if (fs.existsSync(cbzPath)) {
      log(`  SKIP (exists): ${looseName}.cbz`, 'skip');
    } else {
      log(`  Packing loose images → ${looseName}.cbz  (${images.length} images)`, 'info');
      packToCbz(images, cbzPath);
      const v = validateCbz(cbzPath, images.length);
      if (v.valid) {
        log(`  ✓ Valid: ${looseName}.cbz`, 'success');
        outputs.push(cbzPath);
      } else {
        log(`  ERROR: ${v.reason}`, 'error');
        try { fs.unlinkSync(cbzPath); } catch { /* ignore */ }
      }
    }
  }

  return outputs;
}

// ─── Packing ────────────────────────────────────────────────────────────────

/**
 * Pack an array of image file paths into a CBZ (flat ZIP, no internal folder).
 * Image files are stored with natural-sort ordering by filename.
 */
function packToCbz(imageFiles, outputPath) {
  const zip = new AdmZip();
  for (const imgPath of imageFiles) {
    zip.addLocalFile(imgPath, '', path.basename(imgPath));
  }
  zip.writeZip(outputPath);
}

// ─── Core per-file processor ─────────────────────────────────────────────────

// outputDir is used when processing nested archives so outputs land next to the outer archive.
async function processFile(srcFile, isManga, log, signal, outputDir = null) {
  const ext    = path.extname(srcFile).toLowerCase();
  const srcDir = path.dirname(srcFile);
  const outDir = outputDir ?? srcDir;
  const baseName = path.basename(srcFile, ext);
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
      await extractArchive(srcFile, tmpDir, signal);
    }

    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

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
      const outputs = await processDirectoryTree(contentDir, wrapperOutDir, isManga, log, signal);
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
        if (canOpenCbz(outputPath)) {
          log(`  SKIP (exists): ${outputName}.cbz`, 'skip');
          continue;
        }
        log(`  WARN: Existing ${outputName}.cbz is unreadable — re-converting…`, 'warn');
        try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
      }

      log(`  Packing → ${outputName}.cbz  (${group.files.length} images)`, 'info');
      packToCbz(group.files, outputPath);

      // 5. Validate
      const validation = validateCbz(outputPath, group.files.length);
      if (!validation.valid) {
        log(`  ERROR: Validation failed — ${validation.reason}`, 'error');
        try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
        return { success: false, outcome: 'validationFailed', reason: validation.reason, isPdf, pdfPages };
      }

      log(`  ✓ Valid: ${outputName}.cbz`, 'success');
      outputs.push(outputPath);
    }

    const outcome    = outputs.length === 0 ? 'allSkipped'
      : outputs.length === 1 ? 'single' : 'multi';
    const folderName = groups.length > 1 ? baseName : null;
    return { success: outputs.length > 0, outcome, outputs, folderName, isPdf, pdfPages };

  } finally {
    removeTempDir(tmpDir);
  }
}

// ─── Reorganise scattered multi-chapter CBZs ─────────────────────────────────

/**
 * Walk rootDir and reorganize scattered multi-chapter CBZs and cross-language
 * duplicates into named subfolders.
 *
 * Two passes per directory:
 *
 * Pass 1 — split-output grouping:
 *   CBZs sharing the same prefix before their first " - " separator are moved
 *   into  <dir>/<prefix>/.  Works even if the original archive is gone.
 *   Example: "[ENG] Adventure Kid - vol.1.cbz" + "vol.2.cbz"
 *            → "[ENG] Adventure Kid\" folder
 *
 * Pass 2 — cross-language / tag grouping:
 *   CBZ files AND subdirectories are grouped by their "core title" (leading
 *   [LANG]/[TAG] brackets stripped).  Items whose core titles share a
 *   word-prefix are moved into a tag-free folder named after the shortest
 *   core title in the group.
 *   Example: "[ENG] Urotsukidoji\" folder + "[RUS] Urotsukidoji vol01.cbz"
 *            → "Urotsukidoji\" folder containing both
 */
function reorganizeScatteredCbzs(rootDir, log) {
  let moved = 0;

  function stripTags(name) {
    return name.replace(/^\s*(\[[^\]]*\]\s*)+/, '').trim();
  }

  function wordsOf(str) {
    return str.toLowerCase().replace(/[-_]/g, ' ').split(/\s+/).filter(Boolean);
  }

  // Like wordsOf but preserves original capitalisation — used for folder name reconstruction
  function tokensOf(str) {
    return str.replace(/[-_]/g, ' ').split(/\s+/).filter(Boolean);
  }

  function commonPrefixLen(aw, bw) {
    let n = 0;
    while (n < aw.length && n < bw.length && aw[n] === bw[n]) n++;
    return n;
  }

  // Remove trailing tokens that leave parentheses or square brackets unclosed,
  // AND trailing tokens whose only role is to close a bracket opened earlier
  // (e.g. "02)" with no matching "(" in the same token).
  // Examples:
  //   ["Series","Name","(Chapters"]   → ["Series","Name"]
  //   ["Batman","(Vol","1)","Issue"]  → ["Batman"] (strips "Issue","1)","(Vol")
  //   ["Korokoro","Soushi","(v01","02)","[eng]"] → unchanged (balanced)
  function cleanPrefixTokens(tokens) {
    function balance(toks) {
      let p = 0, s = 0;
      for (const t of toks) {
        p += (t.match(/\(/g) || []).length - (t.match(/\)/g) || []).length;
        s += (t.match(/\[/g) || []).length - (t.match(/\]/g) || []).length;
      }
      return { p, s };
    }
    const result = [...tokens];
    let { p, s } = balance(result);
    // Strip tokens from the end until parentheses are balanced
    while (result.length > 0 && (p !== 0 || s !== 0)) {
      const t = result.pop();
      p -= (t.match(/\(/g) || []).length - (t.match(/\)/g) || []).length;
      s -= (t.match(/\[/g) || []).length - (t.match(/\]/g) || []).length;
    }
    return result;
  }

  function moveItem(src, dst, isDir, label, folderName) {
    if (fs.existsSync(dst)) {
      if (!isDir) { try { fs.unlinkSync(src); } catch { /* ignore */ } }
      return;
    }
    try {
      fs.renameSync(src, dst);
      log(`  Moved: ${label}  →  ${folderName}\\`, 'info');
      moved++;
    } catch (err) {
      if (!isDir && err.code === 'EXDEV') {
        try { fs.copyFileSync(src, dst); fs.unlinkSync(src); moved++; } catch { /* ignore */ }
      }
    }
  }

  function walk(dir) {
    // ── Pass 0: flatten self-nesting caused by previous buggy runs ───────────
    // Catches both exact-name repeats ([ENG] X / [ENG] X) and normalisation
    // variants (v01 02 / v01-02 — hyphens vs spaces treated as equivalent).
    const dirWords0 = wordsOf(path.basename(dir));
    try {
      // Find a same-named subdirectory among dir's children (even if other siblings exist)
      const d0 = fs.readdirSync(dir, { withFileTypes: true });
      const sameNameChild = d0.find(
        (e) => e.isDirectory() && wordsOf(e.name).join(' ') === dirWords0.join(' ')
      );
      if (sameNameChild) {
        // Walk from that child to the deepest same-named single-child chain
        let deepest = path.join(dir, sameNameChild.name);
        while (true) {
          let dd;
          try { dd = fs.readdirSync(deepest, { withFileTypes: true }); } catch { break; }
          if (dd.length !== 1 || !dd[0].isDirectory()) break;
          if (wordsOf(dd[0].name).join(' ') !== dirWords0.join(' ')) break;
          deepest = path.join(deepest, dd[0].name);
        }
        // Move deepest's contents directly into dir
        let contentEntries;
        try { contentEntries = fs.readdirSync(deepest, { withFileTypes: true }); } catch { contentEntries = []; }
        for (const ce of contentEntries) {
          const src = path.join(deepest, ce.name);
          const dst = path.join(dir, ce.name);
          if (!fs.existsSync(dst)) {
            try {
              fs.renameSync(src, dst);
              log(`  Flattened: ${ce.name}  →  ${path.basename(dir)}\\`, 'info');
              moved++;
            } catch { /* ignore */ }
          }
        }
        // Delete the now-empty intermediate chain upward to (but not including) dir
        let toDelete = deepest;
        while (path.resolve(toDelete) !== path.resolve(dir)) {
          try { fs.rmdirSync(toDelete); } catch { break; }
          toDelete = path.dirname(toDelete);
        }
      }
    } catch { /* ignore */ }

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    // Names containing "Art of" / "The Art of" are excluded from all grouping.
    const ART_OF_RE = /\b(art|encyclopedia|world)\s+of\b|\bthe\s+(art|encyclopedia|world)\b/i;
    const artOfTest = (s) => ART_OF_RE.test(s.replace(/[_-]/g, ' '));

    // ── Pass 1: group CBZs by prefix before ' - ' ─────────────────────────
    const cbzFiles = entries
      .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.cbz')
      .map((e) => e.name);

    const p1Groups = new Map();
    for (const cbz of cbzFiles) {
      const base   = path.basename(cbz, '.cbz');
      if (artOfTest(base)) continue;
      const sepIdx = base.indexOf(' - ');
      if (sepIdx === -1) continue;
      const prefix = base.slice(0, sepIdx);
      // Guard: skip if prefix words are a prefix of (or equal to) the current dir name words.
      // Uses wordsOf so "v01-02" and "v01 02" are treated as identical.
      const prefixWords1 = wordsOf(prefix);
      const dirWords1    = wordsOf(path.basename(dir));
      if (commonPrefixLen(prefixWords1, dirWords1) >= prefixWords1.length) continue;
      if (!p1Groups.has(prefix)) p1Groups.set(prefix, []);
      p1Groups.get(prefix).push(cbz);
    }

    for (const [prefix, list] of p1Groups) {
      if (list.length < 2) continue;
      const destDir = path.join(dir, prefix);
      try { fs.mkdirSync(destDir, { recursive: true }); } catch { continue; }
      for (const cbz of list) {
        moveItem(path.join(dir, cbz), path.join(destDir, cbz), false, cbz, prefix);
      }
    }

    // ── Pass 2: group CBZs + folders by shared word prefix ────────────────
    // Handles [LANG] variants (Case 1-2) AND subtitle/spin-off variations (Case 3-4).
    // Match rule: items share ≥2 common leading words, OR one name is a full word-prefix
    // of the other (e.g. "Batman" fully inside "Batman Beyond" → match on 1 word).
    let entries2;
    try { entries2 = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries2 = []; }

    const items = entries2
      .filter((e) => (e.isFile() && path.extname(e.name).toLowerCase() === '.cbz') || e.isDirectory())
      .map((e) => {
        const base     = e.isDirectory() ? e.name : path.basename(e.name, '.cbz');
        const stripped = stripTags(base);
        const words    = wordsOf(stripped);
        const tokens   = tokensOf(stripped);
        return { name: e.name, isDir: e.isDirectory(), stripped, words, tokens };
      })
      .filter((e) => e.words.length > 0 && !artOfTest(e.stripped));

    // Build groups; track prefixWords (lowercase) + prefixTokens (original case) per group
    const p2Groups = []; // [{ prefixWords, prefixTokens, items[] }]
    for (const item of items) {
      let bestGroup = null;
      let bestLen   = 0;

      for (const grp of p2Groups) {
        const cp = commonPrefixLen(grp.prefixWords, item.words);
        // qualifies if one name is entirely a prefix of the other, OR ≥2 words shared
        const qualifies = cp > 0 && (cp >= grp.prefixWords.length || cp >= item.words.length || cp >= 2);
        if (qualifies && cp > bestLen) { bestGroup = grp; bestLen = cp; }
      }

      if (bestGroup) {
        bestGroup.items.push(item);
        // Narrow the stored prefix to the actual common prefix
        bestGroup.prefixWords  = bestGroup.prefixWords.slice(0, bestLen);
        bestGroup.prefixTokens = bestGroup.prefixTokens.slice(0, bestLen);
      } else {
        p2Groups.push({ prefixWords: [...item.words], prefixTokens: [...item.tokens], items: [item] });
      }
    }

    for (const { prefixTokens, items: grpItems } of p2Groups) {
      if (grpItems.length < 2) continue;

      // Clean prefix: strip trailing tokens that leave unclosed parentheses/brackets,
      // e.g. "Batman (Vol" → "Batman", "Series (Chapters" → "Series"
      const folderName = cleanPrefixTokens([...prefixTokens]).join(' ');
      if (!folderName || folderName.length < 2) continue;

      // Guard: skip if current dir name (normalised) is a prefix of or equals the group folder name.
      // Catches exact matches, tag variants ([ENG] X inside X), and sub-grouping (X inside X Vol).
      const dirWords2 = wordsOf(stripTags(path.basename(dir)));
      const fnWords2  = wordsOf(folderName);
      if (commonPrefixLen(dirWords2, fnWords2) >= dirWords2.length) continue;

      // If a folder matching the group name already exists (case-insensitive), use it as the
      // container — can't move a folder inside itself, so it stays and others move into it.
      const containerItem = grpItems.find((i) => i.isDir && i.name.toLowerCase() === folderName.toLowerCase());
      const actualFolder  = containerItem ? containerItem.name : folderName;
      const toMove = containerItem ? grpItems.filter((i) => i !== containerItem) : grpItems;
      if (toMove.length === 0) continue;

      const destDir = path.join(dir, actualFolder);
      try { fs.mkdirSync(destDir, { recursive: true }); } catch { continue; }

      for (const item of toMove) {
        const src = path.join(dir, item.name);
        if (!fs.existsSync(src)) continue; // may have been moved by Pass 1
        moveItem(src, path.join(destDir, item.name), item.isDir, item.name, actualFolder);
      }
    }

    // Recurse into subdirs (re-read for updated state after both passes)
    let entries3;
    try { entries3 = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries3.filter((e) => e.isDirectory())) {
      walk(path.join(dir, e.name));
    }
  }

  walk(rootDir);
  return moved;
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
function findOrphanedOriginals(rootDir) {
  const simple      = [];
  const needsReview = [];

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    // Collect files in this directory by extension
    const byExt = { src: [], cbzNames: [], cbzBaseSet: new Set() };
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (ext === '.cbz') {
        byExt.cbzNames.push(e.name);
        byExt.cbzBaseSet.add(path.basename(e.name, '.cbz').toLowerCase());
      } else if (CONVERTIBLE_EXTS.has(ext)) {
        byExt.src.push(e.name);
      }
    }

    for (const name of byExt.src) {
      const base = path.basename(name, path.extname(name)).toLowerCase();
      const full = path.join(dir, name);
      if (byExt.cbzBaseSet.has(base)) {
        // Exact match: Batman.cbr + Batman.cbz → safe to flag only if CBZ is readable
        const cbzPath = path.join(dir, path.basename(name, path.extname(name)) + '.cbz');
        if (!canOpenCbz(cbzPath)) continue; // corrupted CBZ — leave both files alone
        simple.push(full);
      } else if (byExt.cbzNames.length > 0) {
        // CBZ files exist in this folder but no name match →
        // could be a collection archive or split archive that wasn't cleaned up
        needsReview.push({
          file: full,
          nearbyCbzs:    byExt.cbzNames.slice(),
          likelyMatches: likelyCbzMatches(path.basename(name, path.extname(name)), byExt.cbzNames),
        });
      }
    }

    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
    }
  }

  walk(rootDir);
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

  // Reorganize scattered multi-chapter CBZs first, before converting.
  // Runs even when there are no archives to convert — just select the folder
  // and click Start Conversion to reorganize CBZ-only folders.
  const preReorganized = reorganizeScatteredCbzs(rootFolder, log);
  if (preReorganized > 0) {
    log(`Reorganized ${preReorganized} CBZ(s) into subfolders.\n`, 'info');
  }

  const files = scanForFiles(rootFolder);

  if (files.length === 0) {
    log('No convertible files found (.cbr, .rar, .zip, .pdf).', 'info');
    return { converted: [], preExisting: [], needsReview: [] };
  }

  log(`Found ${files.length} file(s) to convert.\n`, 'info');

  const converted     = []; // converted successfully in this run
  const fileDurations = [];
  const outcomes      = []; // per-file outcome for summary

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
      const result = await processFile(file, isManga, log, signal);
      if (result.success) converted.push(file);
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
  const { simple: preExisting, needsReview } = findOrphanedOriginals(rootFolder);

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

  return { converted, preExisting: uniquePreExisting, needsReview };
}

async function convertSingleFile(filePath, isManga, log, signal) {
  return processFile(filePath, isManga, log, signal);
}

module.exports = { startConversion, convertSingleFile };

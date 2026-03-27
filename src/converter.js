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
        ['identify', '-ping', '-format', '%n\n', `${pdfPath}[0]`],
        signal
      );
      const n = parseInt(stdout.trim(), 10);
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
async function extractPdf(srcFile, destDir, totalPages, signal, onPageProgress) {
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
      // Wrapper folder – use archive name, collect all images inside
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

        await extractPdf(srcFile, tmpDir, totalPages, signal, onPageProgress);

        const finalCount = fs.readdirSync(tmpDir)
          .filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).length;
        log(`  PDF extracted: ${finalCount} pages at ${PDF_DPI} DPI`, 'info', true);
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
        return { success: false };
      }
      return { success: true, outputs };
    }

    // 3. Simple structure → image / folder packing
    const archiveParentDir = path.basename(srcDir);
    const groups = buildGroups(tmpDir, baseName, archiveParentDir);

    if (groups.length === 0) {
      log('  WARNING: No images found inside archive', 'warn');
      return { success: false };
    }

    if (groups.length > 1) {
      log(`  Split into ${groups.length} archives`, 'info');
    }

    // 4. Create a CBZ for each group
    const outputs = [];

    for (const group of groups) {
      if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

      const outputName = buildOutputName(group.name, group.parentName, isManga, group.isSplit);
      const outputPath = path.join(outDir, outputName + '.cbz');

      if (fs.existsSync(outputPath)) {
        log(`  SKIP (exists): ${outputName}.cbz`, 'skip');
        continue;
      }

      log(`  Packing → ${outputName}.cbz  (${group.files.length} images)`, 'info');
      packToCbz(group.files, outputPath);

      // 5. Validate
      const validation = validateCbz(outputPath, group.files.length);
      if (!validation.valid) {
        log(`  ERROR: Validation failed — ${validation.reason}`, 'error');
        try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
        return { success: false };
      }

      log(`  ✓ Valid: ${outputName}.cbz`, 'success');
      outputs.push(outputPath);
    }

    return { success: outputs.length > 0, outputs };

  } finally {
    removeTempDir(tmpDir);
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
function findOrphanedOriginals(rootDir) {
  const simple      = [];
  const needsReview = [];

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    // Collect files in this directory by extension
    const byExt = { src: [], cbz: new Set() };
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (ext === '.cbz') byExt.cbz.add(path.basename(e.name, '.cbz').toLowerCase());
      else if (CONVERTIBLE_EXTS.has(ext)) byExt.src.push(e.name);
    }

    for (const name of byExt.src) {
      const base = path.basename(name, path.extname(name)).toLowerCase();
      const full = path.join(dir, name);
      if (byExt.cbz.has(base)) {
        // Exact match: Batman.cbr + Batman.cbz → safe to flag
        simple.push(full);
      } else if (byExt.cbz.size > 0) {
        // CBZ files exist in this folder but no name match →
        // could be a collection archive or split archive that wasn't cleaned up
        needsReview.push(full);
      }
    }

    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
    }
  }

  walk(rootDir);
  return { simple, needsReview };
}

// ─── Main entry point ────────────────────────────────────────────────────────

async function startConversion(options, log, progress, signal, waitIfPaused) {
  const { rootFolder, isManga } = options;

  log(`Scanning: ${rootFolder}`, 'header');
  const files = scanForFiles(rootFolder);

  if (files.length === 0) {
    log('No convertible files found (.cbr, .rar, .zip, .pdf).', 'info');
    return { converted: [], preExisting: [], needsReview: [] };
  }

  log(`Found ${files.length} file(s) to convert.\n`, 'info');

  const converted    = []; // converted successfully in this run
  const fileDurations = [];

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
    } catch (err) {
      if (err.name === 'AbortError') break;
      log(`  ERROR: ${err.message}`, 'error');
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
    for (const f of needsReview) log(`  ? ${path.relative(rootFolder, f)}`, 'skip');
  }

  return { converted, preExisting: uniquePreExisting, needsReview };
}

module.exports = { startConversion };

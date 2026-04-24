'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const COMIC_EXTS = new Set(['.cbz', '.cbr', '.zip', '.rar', '.pdf']);

// Iterative walk — avoids deep-recursion on large trees
function walkSync(rootFolder, signal) {
  const files = [];
  const stack = [rootFolder];
  while (stack.length > 0) {
    if (signal?.aborted) return null;
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (signal?.aborted) return null;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && COMIC_EXTS.has(path.extname(e.name).toLowerCase())) {
        try {
          const stat = fs.statSync(full);
          files.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch { /* skip unreadable */ }
      }
    }
  }
  return files;
}

// MD5 used for content-equality only, not integrity
function md5File(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data',  (chunk) => hash.update(chunk));
    stream.on('end',   ()      => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// Normalises a filename for fuzzy-similarity matching.
// Strips leading articles and collapses separators/punctuation into spaces.
// Keeps numbers so "Batman 001" and "Batman 002" are NOT considered similar.
function normalizeName(filePath) {
  // toLowerCase() runs first so the article regex doesn't need the i flag.
  return path.basename(filePath, path.extname(filePath))
    .toLowerCase()
    .replace(/^(the|a|an) /, '')   // strip leading article (already lowercase)
    .replace(/[^a-z0-9]+/g, ' ')  // non-alphanumeric runs → single space
    .trim();
}

async function scanDuplicates(rootFolder, sendLog, onProgress, signal) {
  sendLog('Scanning for comic files…', 'info');

  const allFiles = walkSync(rootFolder, signal);
  if (allFiles === null) return { groups: [], aborted: true };

  sendLog(`Found ${allFiles.length} file(s).`, 'info');

  // ── Pass 1: Exact duplicates (same size → same MD5) ────────────────────────
  const bySizeMap = new Map();
  for (const f of allFiles) {
    if (f.size === 0) continue;
    if (!bySizeMap.has(f.size)) bySizeMap.set(f.size, []);
    bySizeMap.get(f.size).push(f);
  }

  const toHash = [...bySizeMap.values()].filter((g) => g.length > 1).flat();

  if (toHash.length > 0) {
    sendLog(`Hashing ${toHash.length} size-matched file(s)…`, 'info');
  }

  const hashMap = new Map();
  for (let i = 0; i < toHash.length; i++) {
    if (signal?.aborted) return { groups: [], aborted: true };
    const f = toHash[i];
    try {
      f.hash = await md5File(f.path);
      if (f.hash) {
        if (!hashMap.has(f.hash)) hashMap.set(f.hash, []);
        hashMap.get(f.hash).push(f);
      }
    } catch { /* unreadable — skip */ }
    onProgress(i + 1, toHash.length);
  }

  if (signal?.aborted) return { groups: [], aborted: true };

  const groups  = [];
  const inExact = new Set();

  for (const files of hashMap.values()) {
    if (files.length < 2) continue;
    const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
    groups.push({ type: 'exact', files: sorted });
    sorted.forEach((f) => inExact.add(f.path));
  }

  // ── Pass 2: Same filename, different directories ───────────────────────────
  const byNameMap  = new Map();
  const inSameName = new Set();

  for (const f of allFiles) {
    if (inExact.has(f.path)) continue;
    const k = path.basename(f.path).toLowerCase();
    if (!byNameMap.has(k)) byNameMap.set(k, []);
    byNameMap.get(k).push(f);
  }

  for (const files of byNameMap.values()) {
    if (files.length < 2) continue;
    const dirs = new Set(files.map((f) => path.dirname(f.path)));
    if (dirs.size < 2) continue;                          // same folder — not interesting
    const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
    groups.push({ type: 'samename', files: sorted });
    sorted.forEach((f) => inSameName.add(f.path));
  }

  // ── Pass 3: Similar normalised name ───────────────────────────────────────
  const byNormMap = new Map();

  for (const f of allFiles) {
    if (inExact.has(f.path) || inSameName.has(f.path)) continue;
    const k = normalizeName(f.path);
    if (!k || k.length < 4) continue;
    if (!byNormMap.has(k)) byNormMap.set(k, []);
    byNormMap.get(k).push(f);
  }

  for (const files of byNormMap.values()) {
    if (files.length < 2) continue;
    const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
    groups.push({ type: 'similar', files: sorted });
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const exactCount    = groups.filter((g) => g.type === 'exact').length;
  const sameNameCount = groups.filter((g) => g.type === 'samename').length;
  const similarCount  = groups.filter((g) => g.type === 'similar').length;

  const parts = [];
  if (exactCount    > 0) parts.push(`${exactCount} exact`);
  if (sameNameCount > 0) parts.push(`${sameNameCount} same-name`);
  if (similarCount  > 0) parts.push(`${similarCount} similar`);

  if (parts.length > 0) {
    sendLog(`Found ${groups.length} duplicate group(s): ${parts.join(', ')}.`, 'warn');
  } else {
    sendLog('No duplicates found.', 'success');
  }

  return { groups, aborted: false };
}

module.exports = { scanDuplicates };

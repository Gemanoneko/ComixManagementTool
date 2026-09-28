const path = require('path');
const { execFilePromise } = require('./exec');
const { sevenZipArgs } = require('./seven-zip');
const { getSevenZip } = require('./tools');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif']);

/**
 * Count the image-extension entries in an archive via `7z l -slt` (metadata
 * only).  Same extension-based rule validateCbz applies, so a count taken from
 * a SOURCE archive can be handed to validateCbz as the expected count for its
 * repack.  Throws if the archive cannot be listed.
 *
 * @param {string} archivePath
 * @param {AbortSignal} [signal]
 * @returns {Promise<number>}
 */
async function countImageEntries(archivePath, signal) {
  const sevenZip = getSevenZip();
  if (!sevenZip) throw new Error('7-Zip not found — cannot list archive');
  const { stdout } = await execFilePromise(
    sevenZip, sevenZipArgs('l', ['-slt'], archivePath), signal, { maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.startsWith('Path = ')) return false;
      const ext = path.extname(line.slice(7).trim()).toLowerCase();
      return IMAGE_EXTS.has(ext);
    })
    .length;
}

/**
 * List every entry of an archive via `7z l -slt -sccUTF-8` (metadata only).
 *
 * `-sccUTF-8` matters: without it 7-Zip writes names to a pipe in the OEM
 * code page, so "Ünïcode ✓" arrives as "Unicode _" and names cannot be
 * compared.  Folders are recognised by `Folder = +` (zip, rar) or, for formats
 * that print no Folder field (7z), by a `D` in the Windows attribute letters.
 * `crc` is null when the format stores none for that entry (folders; empty
 * files in 7z archives).  Throws if the archive cannot be listed.
 *
 * @param {string} archivePath
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{ path: string, isDir: boolean, size: number|null, crc: string|null }>>}
 */
async function listEntries(archivePath, signal) {
  const sevenZip = getSevenZip();
  if (!sevenZip) throw new Error('7-Zip not found — cannot list archive');
  const { stdout } = await execFilePromise(
    sevenZip, sevenZipArgs('l', ['-slt', '-sccUTF-8'], archivePath), signal, { maxBuffer: 64 * 1024 * 1024 },
  );
  const lines = stdout.split(/\r?\n/);
  // The block before the first "----------" line describes the archive itself.
  const start = lines.indexOf('----------');
  if (start < 0) throw new Error('Cannot list archive contents');

  const entries = [];
  let cur = null;
  const flush = () => {
    if (!cur || cur.Path === undefined) { cur = null; return; }
    const attrs = (cur.Attributes || '').split(' ')[0];
    const isDir = cur.Folder !== undefined ? cur.Folder === '+' : attrs.includes('D');
    const size  = cur.Size !== undefined && cur.Size !== '' ? Number(cur.Size) : null;
    entries.push({ path: cur.Path, isDir, size, crc: cur.CRC ? cur.CRC.toUpperCase() : null });
    cur = null;
  };
  for (const line of lines.slice(start + 1)) {
    if (line === '') { flush(); continue; }
    const i = line.indexOf(' = ');
    if (i < 0) continue;
    const key = line.slice(0, i);
    if (key === 'Path') flush();
    if (!cur) cur = {};
    cur[key] = line.slice(i + 3);
  }
  flush();
  return entries;
}

/**
 * Check that `outputEntries` (a repacked archive) is an exact copy of
 * `sourceEntries` (the archive it replaces), apart from the entries in
 * `changedPaths`, whose content was deliberately rewritten.
 *
 *   • the same file paths, each exactly once (a duplicate entry in the source
 *     can never be reproduced from one extracted file, so it fails too);
 *   • the same folders — explicit folder entries plus every folder implied by
 *     a path.  7-Zip writes no explicit entry for a folder that has files in
 *     it, so only the implied set is comparable between the two archives;
 *   • the same size, and the same CRC where the source stores one, for every
 *     file that was not changed.
 *
 * Paths compare case-insensitively with `/` and `\` equivalent — the
 * extraction ran on Windows, where those are the same file.  A name 7-Zip
 * could not write as-is on Windows (`..\`, `a:b`, `con`, a trailing dot) was
 * renamed during extraction, so it shows up here as missing + extra.
 *
 * `reason` names the first difference found ("(+N more)" when there are
 * several of that kind); `problems` lists every difference, one record per
 * entry, for callers that report them all (folder-pack).  An entry whose size
 * AND CRC differ is reported once, as a size difference.  `sourceEntries`
 * may carry `crc: null` (a folder on disk has no stored CRC) — then only the
 * size is compared.  `noun` names the copy in the messages.
 *
 * @param {Array<{path:string,isDir:boolean,size:number|null,crc:string|null}>} sourceEntries
 * @param {Array<{path:string,isDir:boolean,size:number|null,crc:string|null}>} outputEntries
 * @param {Iterable<string>} changedPaths  paths (relative, either separator) whose content may differ
 * @param {string} [noun]
 * @returns {{ valid: boolean, reason?: string,
 *             problems: Array<{ path: string,
 *               cause: 'missing'|'size'|'content'|'extra'|'missing-folder'|'extra-folder',
 *               sourceSize?: number, outputSize?: number }> }}   (sizes on 'size' records)
 */
function compareEntries(sourceEntries, outputEntries, changedPaths, noun = 'resized copy') {
  const key = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const changed = new Set([...changedPaths].map(key));

  function index(entries) {
    const files   = new Map();   // key → [entry, …]
    const folders = new Map();   // key → folder path as the archive spells it (for messages)
    for (const e of entries) {
      const k    = key(e.path);
      const disp = e.path.replace(/\//g, '\\').replace(/\\+$/, '');
      if (e.isDir) { if (!folders.has(k)) folders.set(k, disp); }
      else {
        if (!files.has(k)) files.set(k, []);
        files.get(k).push(e);
      }
      for (let i = k.lastIndexOf('\\'); i > 0; i = k.lastIndexOf('\\', i - 1)) {
        if (!folders.has(k.slice(0, i))) folders.set(k.slice(0, i), disp.slice(0, i));
      }
    }
    return { files, folders };
  }
  const src = index(sourceEntries);
  const out = index(outputEntries);

  const missing = [], extra = [], differ = [];   // differ: { path, cause: 'size' | 'content' }
  for (const [k, list] of src.files) {
    const got = out.files.get(k) || [];
    if (got.length < list.length) { missing.push(list[0].path); continue; }
    if (changed.has(k)) continue;
    const s = list[0], o = got[0];
    if (s.size !== o.size)          differ.push({ path: s.path, cause: 'size', sourceSize: s.size, outputSize: o.size });
    else if (s.crc && s.crc !== o.crc) differ.push({ path: s.path, cause: 'content' });
  }
  for (const [k, list] of out.files) {
    const want = src.files.get(k) || [];
    if (list.length > want.length) extra.push(list[0].path);
  }
  const missingFolders = [...src.folders].filter(([k]) => !out.folders.has(k)).map(([, d]) => d);
  const extraFolders   = [...out.folders].filter(([k]) => !src.folders.has(k)).map(([, d]) => d);

  const problems = [
    ...missing.map((p) => ({ path: p, cause: 'missing' })),
    ...differ,
    ...extra.map((p) => ({ path: p, cause: 'extra' })),
    ...missingFolders.map((p) => ({ path: p, cause: 'missing-folder' })),
    ...extraFolders.map((p) => ({ path: p, cause: 'extra-folder' })),
  ];
  const describe = (label, list) => {
    const more = list.length > 1 ? ` (+${list.length - 1} more)` : '';
    return { valid: false, reason: `${label}: ${list[0]}${more}`, problems };
  };

  if (missing.length)        return describe(`Missing from ${noun}`, missing);
  if (differ.length) {
    const label = differ[0].cause === 'size' ? `Size differs in ${noun}` : `Content differs in ${noun}`;
    return describe(label, differ.map((d) => d.path));
  }
  if (extra.length)          return describe(`Unexpected in ${noun}`, extra);
  if (missingFolders.length) return describe(`Folder missing from ${noun}`, missingFolders);
  if (extraFolders.length)   return describe(`Unexpected folder in ${noun}`, extraFolders);
  return { valid: true, problems };
}

/**
 * Validates a CBZ file using 7-Zip — no image data is loaded into Node.js RAM,
 * and the calls are async so the Electron main-process event loop is never blocked.
 *
 * 1. `7z t` — tests CRC of every stored entry (every entry's stored CRC-32
 *    is recomputed from the compressed stream and compared).  This is weaker
 *    than a true magic-byte check — a zero-byte JPEG inside the archive has
 *    CRC-32 = 0x00000000 which is a valid value, so it would pass — but in
 *    practice 7-Zip never produces empty outputs from a valid input source,
 *    so this path is not reachable in normal operation.
 * 2. `7z l -slt` — counts entries with image extensions and compares to
 *    expectedCount.  Extension-based, not content-sniffed.
 *
 * @param {string} cbzPath
 * @param {number} expectedCount  Number of image files that should be inside
 * @param {AbortSignal} [signal]  Optional — kill the child process on abort
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
async function validateCbz(cbzPath, expectedCount, signal) {
  // 1. Integrity test: 7-Zip computes CRC for every entry and compares to stored value.
  const integrity = await testIntegrity(cbzPath, signal);
  if (!integrity.valid) return integrity;

  // 2. List entries and count images (reads only ZIP metadata, not image data).
  let imageCount;
  try {
    imageCount = await countImageEntries(cbzPath, signal);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { valid: false, reason: 'Cannot list archive contents' };
  }

  if (imageCount === 0) return { valid: false, reason: 'CBZ contains no image files' };
  if (imageCount !== expectedCount) {
    return { valid: false, reason: `Image count mismatch: expected ${expectedCount}, found ${imageCount}` };
  }

  return { valid: true };
}

/**
 * Step 1 of validateCbz on its own: `7z t` (CRC of every entry), with no
 * image-count rule — for an archive that legitimately holds no pages (a
 * folder-pack CBZ made from a subfolder of non-page files).  Async, so the
 * IPC event loop stays responsive (Cancel/Pause clicks still work).
 *
 * @param {string} cbzPath
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
async function testIntegrity(cbzPath, signal) {
  const sevenZip = getSevenZip();
  if (!sevenZip) return { valid: false, reason: '7-Zip not found — cannot validate CBZ' };
  try {
    await execFilePromise(sevenZip, sevenZipArgs('t', [], cbzPath), signal, { maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { valid: false, reason: 'Archive integrity test failed (corrupt ZIP or CRC error)' };
  }
  return { valid: true };
}

module.exports = { validateCbz, testIntegrity, countImageEntries, listEntries, compareEntries };

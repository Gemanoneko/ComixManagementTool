const path = require('path');
const { execFilePromise } = require('./exec');
const { sevenZipArgs } = require('./seven-zip');
const { getSevenZip } = require('./tools');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif']);

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
  const sevenZip = getSevenZip();
  if (!sevenZip) return { valid: false, reason: '7-Zip not found — cannot validate CBZ' };

  const execOpts = { maxBuffer: 64 * 1024 * 1024 };

  // 1. Integrity test: 7-Zip computes CRC for every entry and compares to stored value.
  //    Running async keeps the IPC event loop responsive (Cancel/Pause clicks still work).
  try {
    await execFilePromise(sevenZip, sevenZipArgs('t', [], cbzPath), signal, execOpts);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { valid: false, reason: 'Archive integrity test failed (corrupt ZIP or CRC error)' };
  }

  // 2. List entries and count images (reads only ZIP metadata, not image data).
  let stdout;
  try {
    ({ stdout } = await execFilePromise(sevenZip, sevenZipArgs('l', ['-slt'], cbzPath), signal, execOpts));
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { valid: false, reason: 'Cannot list archive contents' };
  }

  const imageCount = stdout
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.startsWith('Path = ')) return false;
      const ext = path.extname(line.slice(7).trim()).toLowerCase();
      return IMAGE_EXTS.has(ext);
    })
    .length;

  if (imageCount === 0) return { valid: false, reason: 'CBZ contains no image files' };
  if (imageCount !== expectedCount) {
    return { valid: false, reason: `Image count mismatch: expected ${expectedCount}, found ${imageCount}` };
  }

  return { valid: true };
}

module.exports = { validateCbz };

const { execFile } = require('child_process');
const path = require('path');
const { getSevenZip } = require('./tools');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif']);

function execFileAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * Validates a CBZ file using 7-Zip — no image data is loaded into Node.js RAM,
 * and the calls are async so the Electron main-process event loop is never blocked.
 *
 * 1. `7z t` — tests CRC of every stored entry (stronger than magic-byte check)
 * 2. `7z l -slt` — counts image entries and compares to expectedCount
 *
 * @param {string} cbzPath
 * @param {number} expectedCount  Number of image files that should be inside
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
async function validateCbz(cbzPath, expectedCount) {
  const sevenZip = getSevenZip();
  if (!sevenZip) return { valid: false, reason: '7-Zip not found — cannot validate CBZ' };

  // 1. Integrity test: 7-Zip computes CRC for every entry and compares to stored value.
  //    Running async keeps the IPC event loop responsive (Cancel/Pause clicks still work).
  try {
    await execFileAsync(sevenZip, ['t', cbzPath]);
  } catch {
    return { valid: false, reason: 'Archive integrity test failed (corrupt ZIP or CRC error)' };
  }

  // 2. List entries and count images (reads only ZIP metadata, not image data).
  let stdout;
  try {
    ({ stdout } = await execFileAsync(sevenZip, ['l', '-slt', cbzPath]));
  } catch {
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

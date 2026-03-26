const AdmZip = require('adm-zip');
const path = require('path');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif']);

// Magic bytes for common image formats
const SIGNATURES = {
  '.png':  { offset: 0, bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  '.jpg':  { offset: 0, bytes: Buffer.from([0xff, 0xd8, 0xff]) },
  '.jpeg': { offset: 0, bytes: Buffer.from([0xff, 0xd8, 0xff]) },
  '.gif':  { offset: 0, bytes: Buffer.from([0x47, 0x49, 0x46]) },
  '.webp': { offset: 0, bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]) }, // RIFF
  '.bmp':  { offset: 0, bytes: Buffer.from([0x42, 0x4d]) },
};

function hasValidSignature(buf, ext) {
  const sig = SIGNATURES[ext];
  if (!sig) return buf && buf.length > 0; // Unknown format: just non-empty
  if (!buf || buf.length < sig.bytes.length) return false;
  return buf.slice(sig.offset, sig.offset + sig.bytes.length).equals(sig.bytes);
}

/**
 * Validates a CBZ file by:
 * 1. Opening it as a zip
 * 2. Counting image entries and comparing to expectedCount
 * 3. Checking magic bytes of every image entry
 *
 * @param {string} cbzPath
 * @param {number} expectedCount  Number of image files that should be inside
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateCbz(cbzPath, expectedCount) {
  let zip;
  try {
    zip = new AdmZip(cbzPath);
  } catch (err) {
    return { valid: false, reason: `Cannot open CBZ: ${err.message}` };
  }

  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const imageEntries = entries.filter((e) => {
    const ext = path.extname(e.entryName).toLowerCase();
    return IMAGE_EXTS.has(ext);
  });

  if (imageEntries.length === 0) {
    return { valid: false, reason: 'CBZ contains no image files' };
  }

  if (imageEntries.length !== expectedCount) {
    return {
      valid: false,
      reason: `Image count mismatch: expected ${expectedCount}, found ${imageEntries.length}`,
    };
  }

  for (const entry of imageEntries) {
    const ext = path.extname(entry.entryName).toLowerCase();
    let data;
    try {
      data = entry.getData();
    } catch (err) {
      return { valid: false, reason: `Cannot read entry "${entry.entryName}": ${err.message}` };
    }

    if (!hasValidSignature(data, ext)) {
      return { valid: false, reason: `Corrupted or unreadable image: ${entry.entryName}` };
    }
  }

  return { valid: true };
}

module.exports = { validateCbz };

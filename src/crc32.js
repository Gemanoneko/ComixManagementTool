'use strict';
/**
 * CRC-32 of a file — the ZIP one, as 7-Zip lists it ("CRC = 2C5D27D5") — read
 * in 1 MB chunks so a large page is never held in memory whole.  Used to check
 * that a CBZ already on disk holds exactly the pages it should (its listing
 * carries each entry's CRC and size).
 */
const fs = require('fs');

const TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c;
}

/**
 * @param {string} file
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}  8 upper-case hex digits
 */
async function crc32File(file, signal) {
  let crc = -1;
  const fh  = await fs.promises.open(file, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  try {
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      for (let i = 0; i < bytesRead; i++) crc = TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
  } finally {
    await fh.close();
  }
  return ((crc ^ -1) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

module.exports = { crc32File };

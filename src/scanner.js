const fs = require('fs');
const path = require('path');

const CONVERTIBLE_EXTS = new Set(['.cbr', '.rar', '.zip', '.pdf']);

/**
 * Recursively walk rootDir and return all files with convertible extensions.
 * Already-.cbz files are intentionally skipped.
 */
// Yield every FILE_YIELD_INTERVAL files processed so very large flat
// directories (10k+ entries) don't block the IPC loop for the duration
// of the enumeration.  Previously the yield was only once per directory,
// which left Cancel/Pause unresponsive during a single big scan.
const FILE_YIELD_INTERVAL = 250;

async function scanForFiles(rootDir) {
  const results = [];
  let filesSinceYield = 0;

  async function walk(dir) {
    await new Promise((r) => setImmediate(r)); // yield between directories
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CONVERTIBLE_EXTS.has(ext)) {
          results.push(fullPath);
        }
        if (++filesSinceYield >= FILE_YIELD_INTERVAL) {
          filesSinceYield = 0;
          await new Promise((r) => setImmediate(r));
        }
      }
    }
  }

  await walk(rootDir);
  return results;
}

module.exports = { scanForFiles };

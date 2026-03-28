const fs = require('fs');
const path = require('path');

const CONVERTIBLE_EXTS = new Set(['.cbr', '.rar', '.zip', '.pdf']);

/**
 * Recursively walk rootDir and return all files with convertible extensions.
 * Already-.cbz files are intentionally skipped.
 */
async function scanForFiles(rootDir) {
  const results = [];

  async function walk(dir) {
    await new Promise((r) => setImmediate(r)); // yield so IPC messages can be processed
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
      }
    }
  }

  await walk(rootDir);
  return results;
}

module.exports = { scanForFiles };

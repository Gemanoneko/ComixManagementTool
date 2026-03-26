const fs = require('fs');
const path = require('path');

const CONVERTIBLE_EXTS = new Set(['.cbr', '.rar', '.zip', '.pdf']);

/**
 * Recursively walk rootDir and return all files with convertible extensions.
 * Already-.cbz files are intentionally skipped.
 */
function scanForFiles(rootDir) {
  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CONVERTIBLE_EXTS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(rootDir);
  return results;
}

module.exports = { scanForFiles };

/**
 * Runtime detection of external tools (7-Zip, ImageMagick).
 *
 * Resolution order for 7-Zip:
 *   1. Bundled inside the app package  (resources/7zip/7z.exe)
 *   2. vendor/7zip/7z.exe              (dev mode after running prepare-vendor)
 *   3. Common Windows install paths
 *   4. PATH
 *
 * Resolution order for ImageMagick:
 *   1. Any ImageMagick* folder under C:\Program Files (highest version first)
 *   2. PATH
 */

const path = require('path');
const fs   = require('fs');
const { execFileSync } = require('child_process');

function isPackaged() {
  try {
    return require('electron').app.isPackaged;
  } catch {
    return false;
  }
}

/** Root of bundled resources when packaged, or vendor/ in dev. */
function resourcesRoot() {
  if (isPackaged()) return process.resourcesPath;
  return path.join(__dirname, '..', 'vendor');
}

// ── 7-Zip ────────────────────────────────────────────────────────────────────

function findSevenZip() {
  // 1. Bundled / vendor
  const bundled = path.join(resourcesRoot(), '7zip', '7z.exe');
  if (fs.existsSync(bundled)) return bundled;

  // 2. System install paths
  for (const p of [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ]) {
    if (fs.existsSync(p)) return p;
  }

  // 3. PATH
  try {
    const out = execFileSync('where', ['7z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.trim().split(/\r?\n/)[0].trim();
    if (first) return first;
  } catch { /* not in PATH */ }

  return null;
}

// ── ImageMagick ───────────────────────────────────────────────────────────────

function findImageMagick() {
  // 1. Scan C:\Program Files for any ImageMagick* folder (newest version wins)
  try {
    const base = 'C:\\Program Files';
    const dirs = fs.readdirSync(base)
      .filter((d) => /^ImageMagick/i.test(d))
      .sort()
      .reverse(); // highest version string first

    for (const d of dirs) {
      const exe = path.join(base, d, 'magick.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* can't read Program Files */ }

  // 2. PATH
  try {
    const out = execFileSync('where', ['magick'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.trim().split(/\r?\n/)[0].trim();
    if (first) return first;
  } catch { /* not in PATH */ }

  return null;
}

// ── Cached accessors ──────────────────────────────────────────────────────────

let _7z  = null;
let _im  = null;

function getSevenZip() {
  if (!_7z) _7z = findSevenZip();
  return _7z;
}

function getImageMagick() {
  if (!_im) _im = findImageMagick();
  return _im;
}

module.exports = { getSevenZip, getImageMagick };

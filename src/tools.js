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

// m4: Windows `where.exe` searches the CURRENT DIRECTORY before PATH, so if
// the app were ever launched from a folder containing a spoofed `7z.exe`,
// that binary would win.  Resolve `where` via its absolute System32 path and
// never pass a search directory so only PATH is consulted.
const SYSTEM32          = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const WHERE_EXE         = path.join(SYSTEM32, 'where.exe');
const EXTRA_PATH_DIRS   = [
  SYSTEM32,
  path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0'),
].filter((d) => {
  try { return fs.existsSync(d); } catch { return false; }
});

function whereLookup(name) {
  // Use the absolute `where.exe` path, and give it a Path-augmented env that
  // explicitly includes System32 + WindowsPowerShell so the resolution order
  // is deterministic regardless of caller PATH quirks.
  try {
    const env = { ...process.env };
    const existing = env.Path || env.PATH || '';
    env.Path = [...EXTRA_PATH_DIRS, existing].filter(Boolean).join(path.delimiter);
    const out = execFileSync(WHERE_EXE, [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    });
    const first = out.trim().split(/\r?\n/)[0].trim();
    return first || null;
  } catch { return null; }
}

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

  // 3. PATH (via absolute where.exe — see whereLookup comment)
  return whereLookup('7z');
}

// ── ImageMagick ───────────────────────────────────────────────────────────────

function findImageMagick() {
  // 1. Scan C:\Program Files for any ImageMagick* folder (newest version wins)
  //    M5: numeric-aware sort so "7.1.11" > "7.1.2" rather than the
  //    lexicographic '1' < '2' that makes .sort() pick the OLDER install.
  try {
    const base = 'C:\\Program Files';
    const dirs = fs.readdirSync(base)
      .filter((d) => /^ImageMagick/i.test(d))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); // highest version first

    for (const d of dirs) {
      const exe = path.join(base, d, 'magick.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* can't read Program Files */ }

  // 2. PATH (via absolute where.exe — see whereLookup comment)
  return whereLookup('magick');
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

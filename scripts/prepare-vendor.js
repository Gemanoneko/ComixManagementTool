/**
 * prepare-vendor.js
 *
 * Copies 7z.exe + 7z.dll from the local 7-Zip installation into vendor/7zip/
 * so that electron-builder can bundle them inside the standalone .exe.
 *
 * Run once before building:
 *   node scripts/prepare-vendor.js
 *   -- or --
 *   npm run prepare-vendor   (alias in package.json)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SEVEN_ZIP_SRC = 'C:\\Program Files\\7-Zip';
const VENDOR_DST    = path.join(__dirname, '..', 'vendor', '7zip');
const REQUIRED_FILES = ['7z.exe', '7z.dll'];

// Verify source exists
if (!fs.existsSync(SEVEN_ZIP_SRC)) {
  console.error(`\nERROR: 7-Zip not found at "${SEVEN_ZIP_SRC}".`);
  console.error('Install 7-Zip from https://www.7-zip.org/ and re-run this script.\n');
  process.exit(1);
}

fs.mkdirSync(VENDOR_DST, { recursive: true });

let ok = true;
for (const file of REQUIRED_FILES) {
  const src = path.join(SEVEN_ZIP_SRC, file);
  const dst = path.join(VENDOR_DST, file);

  if (!fs.existsSync(src)) {
    console.error(`  MISSING: ${src}`);
    ok = false;
    continue;
  }

  fs.copyFileSync(src, dst);
  const size = (fs.statSync(dst).size / 1024).toFixed(0);
  console.log(`  Copied: ${file}  (${size} KB)`);
}

if (!ok) {
  console.error('\nSome files were missing. Aborting.\n');
  process.exit(1);
}

console.log(`\nvendor/7zip is ready. You can now run: npm run dist\n`);

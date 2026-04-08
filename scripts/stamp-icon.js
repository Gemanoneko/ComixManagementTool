'use strict';
/**
 * Post-build step: stamp the comic book icon onto the built exe using rcedit.
 * Run automatically via `npm run dist` (chained after electron-builder).
 */
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const RCEDIT  = path.join(__dirname, 'rcedit-x64.exe');
const EXE     = path.join(ROOT, 'dist', 'win-unpacked', 'ComixManagementTool.exe');
const ICON    = path.join(ROOT, 'assets', 'icon.ico');

console.log('Stamping icon onto exe...');
try {
  execFileSync(RCEDIT, [EXE, '--set-icon', ICON]);
  console.log('Icon stamped successfully.');
} catch (err) {
  console.error('Failed to stamp icon:', err.message);
  process.exit(1);
}

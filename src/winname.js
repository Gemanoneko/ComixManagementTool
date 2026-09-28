'use strict';
/**
 * Windows device names — CON, PRN, AUX, NUL, COM1–9, LPT1–9 — as file or
 * folder names.  NTFS can hold such a name (the app writes through `\\?\`
 * paths), but ordinary Windows paths map it to the device: Explorer and most
 * programs then can't open, rename or delete it.  Older Windows does this
 * with an extension too ("nul.cbz"); Windows 11 still does it for a bare name
 * (a folder "nul").  So no name the app creates may be one.
 *
 * The device part is the name before the first `.`, trailing spaces ignored,
 * any case ("con", "Con.txt", "NUL .cbz", "com1.tar.gz").
 */
const DEVICE_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function deviceStem(name) {
  const dot  = name.indexOf('.');
  const base = dot < 0 ? name : name.slice(0, dot);
  return base.replace(/\s+$/, '');
}

function isDeviceName(name) {
  return DEVICE_STEM.test(deviceStem(name));
}

/**
 * Judy's `_` rule (the one the fix flow uses for renames): append `_` to the
 * device part, so the extension survives — "con" → "con_", "nul.cbz" →
 * "nul_.cbz", "Com1.tar.gz" → "Com1_.tar.gz".  Any other name is returned as is.
 */
function avoidDeviceName(name) {
  if (!isDeviceName(name)) return name;
  const stem = deviceStem(name);
  return stem + '_' + name.slice(stem.length);
}

module.exports = { isDeviceName, avoidDeviceName };

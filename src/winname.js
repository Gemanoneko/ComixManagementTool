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
  const rest = name.slice(stem.length);
  // Spaces with nothing after them ("LPT9 " from "LPT9 .cbz") are dropped:
  // kept, they would leave a name ending in a space ("LPT9_ ").
  return stem + '_' + (rest.trim() === '' ? '' : rest);
}

/**
 * The name for a folder the app creates from another name (an archive's name
 * without its extension, an ext-folder's name without its extension).
 * Ordinary Windows paths drop trailing spaces and periods, so Explorer and
 * most programs can't open a folder named "Foo " or "Vol 2.".  The trailing
 * run is dropped, as avoidDeviceName drops trailing spaces ("LPT9 " →
 * "LPT9_"); then the device rule applies; nothing left → `_`.  The fix flow's
 * rename does the same in its default mode (sanitizeName, 'remove').
 *   "Foo " → "Foo", "Vol. 2." → "Vol. 2", "nul." → "nul_", " " → "_".
 */
function safeFolderName(name) {
  return avoidDeviceName(name.replace(/[ .]+$/, '')) || '_';
}

module.exports = { isDeviceName, avoidDeviceName, safeFolderName };

'use strict';
/**
 * 7-Zip argv helper.
 *
 * Builds an argv that ALWAYS injects `--` before the first filename operand,
 * so a file whose name starts with `-` (e.g. "-ao.cbz") can never be
 * interpreted by 7-Zip as a switch.  This is a switch-injection vector, not
 * a shell-injection one — 7-Zip parses its own argv, so every call site
 * needs the guard individually.
 *
 * API  — explicit partitioning
 *   sevenZipArgs(op, switches, ...operands)
 *
 *   op        – 7-Zip command letter  ('a', 'x', 'l', 't', 'e', …)
 *   switches  – array of flag strings ('-slt', '-y', '-tzip', `-o${dir}`, …)
 *               NOTE: MUST be real 7-Zip switches — never a filename that
 *               happens to start with `-`.  Prefix-sniffing the string is
 *               unsafe because the whole point of `--` is to protect paths
 *               whose name starts with `-`, and we cannot tell a path
 *               "-foo.cbz" from the switch "-foo" by inspection.
 *   operands  – any number of filename / list-file args, in the order 7-Zip
 *               expects (e.g. `archive.cbz` for list, or `archive.cbz ...`
 *               for add).  `@listfile` is already self-disambiguating but
 *               it's still fine to pass through this slot.
 *
 * Examples
 *   sevenZipArgs('l', ['-slt'], cbzPath)
 *     → ['l', '-slt', '--', cbzPath]
 *
 *   sevenZipArgs('x', [`-o${destDir}`, '-y'], srcFile)
 *     → ['x', `-o${destDir}`, '-y', '--', srcFile]
 *
 *   sevenZipArgs('a', ['-tzip', '-mx=0'], outputPath, `@${listPath}`)
 *     → ['a', '-tzip', '-mx=0', '--', outputPath, `@${listPath}`]
 */
function sevenZipArgs(op, switches, ...operands) {
  if (!Array.isArray(switches)) {
    throw new TypeError('sevenZipArgs: `switches` must be an array (use [] for none)');
  }
  // Sanity — every switch string MUST start with '-' so a caller mistake
  // (passing a path in the switches slot) surfaces loudly.
  for (const s of switches) {
    if (typeof s !== 'string' || !s.startsWith('-')) {
      throw new TypeError(`sevenZipArgs: non-switch "${s}" in switches slot — put filenames in the operands slot instead`);
    }
  }
  return [op, ...switches, '--', ...operands];
}

module.exports = { sevenZipArgs };

'use strict';
/**
 * 7-Zip argv helper.
 *
 * Two threats to defend against, and they pull in opposite directions:
 *
 *   1. Switch-injection on operands. If a user-supplied path resolves to
 *      something starting with `-` (e.g. "-ao.cbz"), 7-Zip parses it as a
 *      switch — not a shell-injection issue, but 7-Zip parses its own argv,
 *      so every call site needs the guard individually.
 *
 *   2. `@listfile` (read filenames from list file) does NOT work past `--`.
 *      Per `7z --help`: `--` "Stop switches and @listfile parsing." Past it
 *      every token is a literal positional, and 7-Zip then tries to use
 *      `@C:\…\listfile` as the archive_name positional (Windows rejects it
 *      as invalid filename syntax, or worse — uses it verbatim).
 *      So when a listfile is in play, there must be NO `--` between
 *      switches and operands.
 *
 * Strategy
 *   • Always neutralize switch-shaped operands by prefixing `.\` (Windows) or
 *     `./` (POSIX) when an operand begins with `-`. This makes the operand
 *     unambiguous to 7-Zip without relying on `--`.
 *   • When no `@listfile` is in `switches`, also keep `--` as belt-and-
 *     suspenders (zero behaviour change for those call sites).
 *   • When an `@listfile` token IS in `switches`, drop `--` and emit the
 *     listfile as the LAST positional. That matches 7-Zip's documented
 *     grammar: `7z <cmd> [<switches>...] <archive_name> [<file_names>...] [@listfile]`.
 *
 * API  — explicit partitioning (call sites unchanged)
 *   sevenZipArgs(op, switches, ...operands)
 *
 *   op        – 7-Zip command letter  ('a', 'x', 'l', 't', 'e', …)
 *   switches  – array of flag strings ('-slt', '-y', '-tzip', `-o${dir}`, …).
 *               `@filename` (read filenames from list file) belongs HERE —
 *               the helper detects it and emits the correct argv shape.
 *   operands  – any number of filename args, in the order 7-Zip expects.
 *
 * Examples
 *   sevenZipArgs('l', ['-slt'], cbzPath)
 *     → ['l', '-slt', '--', cbzPath]
 *
 *   sevenZipArgs('x', [`-o${destDir}`, '-y'], srcFile)
 *     → ['x', `-o${destDir}`, '-y', '--', srcFile]
 *
 *   sevenZipArgs('a', ['-tzip', '-mx=0', `@${listPath}`], outputPath)
 *     → ['a', '-tzip', '-mx=0', outputPath, `@${listPath}`]
 *       (no `--` — 7-Zip stops parsing @listfile past `--`. outputPath gets
 *        a `.\` prefix if it would otherwise start with `-`.)
 */

// Prefix that disambiguates a path beginning with `-` from a switch, without
// changing what 7-Zip ultimately writes/reads. `.\foo` and `foo` resolve to
// the same file on Windows; same for `./foo` on POSIX.
const SAFE_PREFIX = process.platform === 'win32' ? '.\\' : './';

function neutralizeOperand(p) {
  if (typeof p !== 'string') {
    throw new TypeError(`sevenZipArgs: operand must be a string, got ${typeof p}`);
  }
  // Absolute paths, drive-letter paths, UNC paths, and `\\?\` long paths all
  // start with characters other than `-`, so they pass through untouched.
  // Only relative paths with a leading `-` need the prefix.
  if (p.startsWith('-')) return SAFE_PREFIX + p;
  return p;
}

function sevenZipArgs(op, switches, ...operands) {
  if (!Array.isArray(switches)) {
    throw new TypeError('sevenZipArgs: `switches` must be an array (use [] for none)');
  }
  // Sanity — every switch string MUST start with '-' or '@' (list-file switch).
  // A caller mistake (passing a path in the switches slot) surfaces loudly.
  for (const s of switches) {
    if (typeof s !== 'string' || !(s.startsWith('-') || s.startsWith('@'))) {
      throw new TypeError(`sevenZipArgs: non-switch "${s}" in switches slot — put filenames in the operands slot instead`);
    }
  }

  // Split off any @listfile tokens — they cannot sit before `--`.
  const realSwitches = [];
  const listFiles    = [];
  for (const s of switches) {
    if (s.startsWith('@')) listFiles.push(s);
    else realSwitches.push(s);
  }

  const safeOperands = operands.map(neutralizeOperand);

  if (listFiles.length === 0) {
    // No listfile → keep `--` as defence-in-depth alongside the operand
    // prefix.  Behaviour identical to the pre-listfile-fix shape.
    return [op, ...realSwitches, '--', ...safeOperands];
  }

  // Listfile present → no `--`, listfile(s) last as trailing positionals.
  // Switch-injection on operands is already blocked by neutralizeOperand.
  return [op, ...realSwitches, ...safeOperands, ...listFiles];
}

module.exports = { sevenZipArgs };

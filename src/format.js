'use strict';
/**
 * Size formatting shared by Resize, folder-pack and the validator.
 * (formatBytes moved here from resizer.js, which still re-exports it, so the
 * validator can use it without a require cycle.)
 */

function formatBytes(bytes) {
  if (bytes <= 0)              return '0 B';
  if (bytes < 1024)            return `${bytes} B`;
  if (bytes < 1024 * 1024)     return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)       return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Two sizes for a "<a> in X but <b> in Y" message.  When formatBytes would
 * print them the same ("1.5 MB" / "1.5 MB") the exact byte counts are used
 * instead ("1572864 bytes" / "1572870 bytes") — Judy's verdict.
 */
function sizePair(a, b) {
  const fa = formatBytes(a), fb = formatBytes(b);
  if (fa !== fb) return [fa, fb];
  const bytes = (n) => `${n} ${n === 1 ? 'byte' : 'bytes'}`;
  return [bytes(a), bytes(b)];
}

module.exports = { formatBytes, sizePair };

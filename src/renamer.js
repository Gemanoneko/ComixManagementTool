/**
 * Naming rules:
 *
 * Only rename if the name is GENERIC (e.g. "chapter_5", "vol_02", "001").
 * Clear names like "Batman - Volume 3 - #45" are left untouched.
 *
 * Comics pattern:  Series Name - Volume X - #Issue (YYYY) {Publisher}
 * Manga  pattern:  Series Title - Vol XX - Ch YYY [Scanlator] (YYYY) {Language}
 *
 * When splitting a multi-folder archive:
 *   - subdir name is not generic  →  "<archiveName> - <subdirName>"
 *   - subdir name is generic      →  built from context using archiveName as series
 *
 * For top-level archives:
 *   - archive name is not generic →  keep as-is
 *   - archive name is generic     →  built from context using parentDir as series
 */

const GENERIC_PATTERNS = [
  /^chapter[_\s-]?\d+$/i,
  /^ch[_\s-]?\d+$/i,
  /^vol(?:ume)?[_\s-]?\d+$/i,
  /^issue[_\s-]?\d+$/i,
  /^part[_\s-]?\d+$/i,
  /^tome[_\s-]?\d+$/i,
  /^\d+$/,                    // pure number: "001"
  /^[a-z]{1,6}[_\s-]\d+$/i,  // generic_prefix_001
];

function isGenericName(name) {
  const clean = name.replace(/\.[^.]+$/, '').trim();
  return GENERIC_PATTERNS.some((p) => p.test(clean));
}

/** Extract vol/chapter numbers embedded in a string */
function extractNumbers(name) {
  const volMatch = name.match(/vol(?:ume)?[_\s-]?(\d+)/i);
  const chMatch = name.match(/(?:ch(?:apter)?|issue|part|tome)[_\s-]?(\d+)/i);
  const pureNum = name.match(/^(\d+)$/);

  return {
    vol: volMatch ? volMatch[1].padStart(2, '0') : null,
    ch: chMatch
      ? chMatch[1].padStart(3, '0')
      : pureNum
      ? pureNum[1].padStart(3, '0')
      : null,
  };
}

function sanitize(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[._\s]+$/, ''); // no trailing dots/spaces (Windows)
}

/**
 * Build the output CBZ name (without extension).
 *
 * @param {string} name       - Subdir name or archive base name
 * @param {string} parentName - Archive name (for subdirs) or parent folder (for archives)
 * @param {boolean} isManga
 * @param {boolean} isSplit   - True when this name comes from a subdir inside a split archive
 */
function buildOutputName(name, parentName, isManga, isSplit = false) {
  const cleanName = sanitize(name);
  const cleanParent = sanitize(parentName || '');

  // Not generic and not a split → preserve as-is
  if (!isSplit && !isGenericName(cleanName)) {
    return cleanName;
  }

  // Not generic but IS a split subdir → prefix with parent
  if (isSplit && !isGenericName(cleanName)) {
    return cleanParent ? `${cleanParent} - ${cleanName}` : cleanName;
  }

  // Generic name → build from context
  const { vol, ch } = extractNumbers(cleanName);
  const series = cleanParent || 'Unknown Series';

  if (isManga) {
    // Series Title - Vol XX - Ch YYY
    let out = series;
    if (vol) out += ` - Vol ${vol}`;
    if (ch) out += ` - Ch ${ch}`;
    if (!vol && !ch) out += ` - ${cleanName}`;
    return out;
  } else {
    // Series Name - Volume X - #Issue
    let out = series;
    if (vol) out += ` - Volume ${vol}`;
    if (ch) out += ` - #${ch}`;
    if (!vol && !ch) out += ` - ${cleanName}`;
    return out;
  }
}

module.exports = { buildOutputName, isGenericName };

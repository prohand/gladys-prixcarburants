// -----------------------------------------------------------------------------
// Text helpers shared by the country providers.
//
// Open data columns arrive with double spaces, trailing tabs and the occasional
// non-breaking space: normalizing once here keeps the parsing readable and the
// station names presentable.
// -----------------------------------------------------------------------------

/**
 * Collapse the whitespace of a value and trim it. `null`/`undefined` become an
 * empty string, so a missing column is falsy and never prints "undefined".
 * @param {unknown} value
 * @returns {string}
 */
export function cleanText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

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

// `2026-08-06T07:12:00+02:00`, `2026-08-06 07:12:00`, `2026-08-06T07:12` — the
// date and the time are always in that order, the rest is optional noise.
const DATE_TIME_PATTERN = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/;

/**
 * Turn an open data timestamp into something readable on a dashboard tile.
 *
 * The raw column is published as an ISO string, which reads as
 * `2026-08-06T07:12:00+02:00` in the Gladys UI — technically exact, unpleasant
 * at a glance. We cut it down to `2026-08-06 07:12`: same order as the source,
 * so it stays unambiguous for every reader and sorts naturally, minus the
 * seconds nobody needs on a price declared once a week.
 *
 * The parsing is TEXTUAL on purpose. `new Date(...)` would re-express the
 * instant in the timezone of the CONTAINER (UTC in the Gladys sandbox) and show
 * a station that changed its price at 07:12 as having done it at 05:12. The
 * declared wall-clock time is the one the driver saw on the roadside sign, so
 * it is the one we keep — offset included in the source or not.
 *
 * @param {unknown} value raw timestamp from the feed
 * @returns {string} readable timestamp, the cleaned input when unparseable,
 *   `''` when there is nothing to show
 */
export function formatDateTime(value) {
  const raw = cleanText(value);
  const match = DATE_TIME_PATTERN.exec(raw);
  if (!match) {
    // Unknown shape: showing the publisher's own string beats showing nothing.
    return raw;
  }
  const [, year, month, day, hours, minutes] = match;
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

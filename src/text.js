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
 * The one format every date of this integration is displayed in, on the
 * dashboard as in the device page: `08/08/2026 à 21:00`.
 */
function frenchDateTime({ year, month, day, hours, minutes }) {
  return `${day}/${month}/${year} à ${hours}:${minutes}`;
}

const pad = (value) => String(value).padStart(2, '0');

/**
 * Turn an open data timestamp into something readable on a dashboard tile.
 *
 * The raw column is published as an ISO string, which reads as
 * `2026-08-06T07:12:00+02:00` in the Gladys UI — technically exact, unpleasant
 * at a glance. We cut it down to `06/08/2026 à 07:12`, minus the seconds nobody
 * needs on a price declared once a week.
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
  return frenchDateTime({ year, month, day, hours, minutes });
}

/**
 * Same display, for an instant WE observed rather than one the feed declared —
 * the moment the integration last read the open data API.
 *
 * Here the local time of the container is the right frame: it is the timezone
 * the Gladys box runs in, hence the one the user reads their dashboard in.
 *
 * @param {Date|number|null|undefined} instant a Date or an epoch in ms
 * @returns {string} `''` when there is no instant to show
 */
export function formatInstant(instant) {
  if (instant === null || instant === undefined) {
    return '';
  }
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return frenchDateTime({
    year: date.getFullYear(),
    month: pad(date.getMonth() + 1),
    day: pad(date.getDate()),
    hours: pad(date.getHours()),
    minutes: pad(date.getMinutes()),
  });
}

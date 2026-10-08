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
 * The date and the time of a feed timestamp, as strings, or `null` when the
 * value does not hold one.
 *
 * Exposed because the dashboard needs the same TEXTUAL reading for a shorter
 * display (`06/08`, see src/widgets/format.js): re-parsing the feed string with
 * `new Date(...)` there would re-introduce the timezone shift this module
 * exists to avoid.
 *
 * @param {unknown} value raw timestamp from the feed
 * @returns {{ year: string, month: string, day: string, hours: string,
 *   minutes: string }|null}
 */
export function parseDateTimeParts(value) {
  const match = DATE_TIME_PATTERN.exec(cleanText(value));
  if (!match) {
    return null;
  }
  const [, year, month, day, hours, minutes] = match;
  return { year, month, day, hours, minutes };
}

/**
 * The one format every date of this integration is displayed in, on the
 * dashboard as in the device page: `08/08/2026 à 21:00`.
 */
function frenchDateTime({ year, month, day, hours, minutes }) {
  return `${day}/${month}/${year} à ${hours}:${minutes}`;
}

/**
 * The timezone the user reads their dashboard in, when nothing says otherwise.
 * France is the only country a provider exists for — and the price feed itself
 * declares its times on the French wall clock.
 */
export const DEFAULT_TIME_ZONE = 'Europe/Paris';

/** @type {Map<string, Intl.DateTimeFormat>} */
const formatters = new Map();

/**
 * A formatter giving the wall-clock fields of an instant in `timeZone`, or
 * `null` when the zone is not one the runtime knows.
 * @param {string} timeZone
 */
function wallClockFormatter(timeZone) {
  if (!formatters.has(timeZone)) {
    let formatter = null;
    try {
      formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      // RangeError: unknown zone.
    }
    formatters.set(timeZone, formatter);
  }
  return formatters.get(timeZone);
}

/**
 * The timezone the instants WE observe are displayed in.
 *
 * Never the container's own clock: the Gladys sandbox sets no `TZ`, so the
 * container runs in UTC and a feed read at 11:00 in Paris was dated 09:00 on
 * the dashboard. `TZ` still wins when it is set to a zone the runtime knows —
 * an install outside France can say so — and anything else (unset, empty,
 * `:/etc/localtime`, a typo) falls back on `Europe/Paris`.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string} an IANA zone name
 */
export function displayTimeZone(env = process.env) {
  const zone = String(env.TZ ?? '').trim();
  if (zone && !zone.startsWith(':') && wallClockFormatter(zone)) {
    return zone;
  }
  return DEFAULT_TIME_ZONE;
}

/**
 * The wall-clock date and time of an instant in a timezone, as numbers.
 * @param {Date|number} instant
 * @param {string} [timeZone]
 * @returns {{ year: number, month: number, day: number, hours: number,
 *   minutes: number }|null} `null` for an invalid instant
 */
export function zonedParts(instant, timeZone = displayTimeZone()) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const formatter = wallClockFormatter(timeZone) ?? wallClockFormatter(DEFAULT_TIME_ZONE);
  const fields = {};
  for (const { type, value } of formatter.formatToParts(date)) {
    fields[type] = Number(value);
  }
  return {
    year: fields.year,
    month: fields.month,
    day: fields.day,
    hours: fields.hour,
    minutes: fields.minute,
  };
}

/** How far `timeZone` is ahead of UTC at that instant, in ms (minute precision). */
function zoneOffsetMs(epochMs, timeZone) {
  const parts = zonedParts(epochMs, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hours, parts.minutes);
  return asUtc - (epochMs - (((epochMs % 60_000) + 60_000) % 60_000));
}

/**
 * The instant of the midnight that opened the day of `instant`, in `timeZone`.
 * The offset is read again AT that midnight, so a day that changes to or from
 * summer time still starts at 00:00 on the local clock.
 * @param {Date|number} instant
 * @param {string} [timeZone]
 * @returns {Date}
 */
export function startOfZonedDay(instant, timeZone = displayTimeZone()) {
  const epochMs = instant instanceof Date ? instant.getTime() : Number(instant);
  const { year, month, day } = zonedParts(epochMs, timeZone);
  const midnightUtc = Date.UTC(year, month - 1, day);
  const guess = midnightUtc - zoneOffsetMs(epochMs, timeZone);
  return new Date(midnightUtc - zoneOffsetMs(guess, timeZone));
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
  const parts = parseDateTimeParts(value);
  if (!parts) {
    // Unknown shape: showing the publisher's own string beats showing nothing.
    return cleanText(value);
  }
  return frenchDateTime(parts);
}

/**
 * Same display, for an instant WE observed rather than one the feed declared —
 * the moment the integration last read the open data API.
 *
 * Expressed in `displayTimeZone()` — the user's wall clock, `Europe/Paris`
 * unless `TZ` names another zone — and NOT in the container's local time: the
 * sandbox sets no `TZ`, so that local time is UTC and a read at 11:00 in Paris
 * used to show as 09:00.
 *
 * @param {Date|number|null|undefined} instant a Date or an epoch in ms
 * @param {{ timeZone?: string }} [options] the zone, for the tests
 * @returns {string} `''` when there is no instant to show
 */
export function formatInstant(instant, { timeZone = displayTimeZone() } = {}) {
  if (instant === null || instant === undefined) {
    return '';
  }
  const parts = zonedParts(instant, timeZone);
  if (!parts) {
    return '';
  }
  return frenchDateTime({
    year: parts.year,
    month: pad(parts.month),
    day: pad(parts.day),
    hours: pad(parts.hours),
    minutes: pad(parts.minutes),
  });
}

// The street types that make a French address long without making it clearer:
// the number and the street name are what tell two stations apart, "Avenue"
// never is. Abbreviated rather than dropped, because "33 Médéric" reads wrong.
const STREET_TYPES = [
  [/\bavenue\b/gi, 'Av.'],
  [/\bboulevard\b/gi, 'Bd'],
  [/\bchemin\b/gi, 'Ch.'],
  [/\bimpasse\b/gi, 'Imp.'],
  [/\ball[ée]e(s)?\b/gi, 'All.'],
  [/\bplace\b/gi, 'Pl.'],
  [/\bquartier\b/gi, 'Qu.'],
  [/\broute\b/gi, 'Rte'],
  [/\brond[- ]point\b/gi, 'Rd-Pt'],
  [/\bzone (artisanale|industrielle|commerciale)\b/gi, 'ZA'],
];

// Long enough for "104/106 Av. Médéric", short enough to stay readable next to
// the brand, the city and the fuel in a device name.
const MAX_ADDRESS_LENGTH = 28;

/**
 * A street, shortened for display: "33 Avenue Médéric" -> "33 Av. Médéric".
 *
 * Used to tell apart two stations of the same brand in the same city, which is
 * the only thing their names differ by. The abbreviations are cosmetic — the
 * full address stays available in the device params.
 *
 * @param {unknown} address
 * @returns {string} `''` when there is no address to show
 */
export function shortenAddress(address) {
  let text = cleanText(address);
  if (!text) {
    return '';
  }
  for (const [pattern, replacement] of STREET_TYPES) {
    text = text.replace(pattern, replacement);
  }
  text = cleanText(text);
  if (text.length > MAX_ADDRESS_LENGTH) {
    // Cut on a word boundary when there is one close enough, so the result
    // does not end mid-word.
    const cut = text.slice(0, MAX_ADDRESS_LENGTH);
    const space = cut.lastIndexOf(' ');
    text = `${(space > MAX_ADDRESS_LENGTH / 2 ? cut.slice(0, space) : cut).trim()}…`;
  }
  return text;
}

// -----------------------------------------------------------------------------
// Small formatting helpers shared by the two widgets.
//
// The core formats the NUMBERS it renders itself (a `value` tile receives a raw
// number and displays it in the account's locale). What it cannot format is the
// free text we compose — "1,699 €/L · 2,3 km" in one string — so those few
// places take the `language` the core sends with every `widget.get` and build
// the sentence in it.
// -----------------------------------------------------------------------------

import { cleanText, parseDateTimeParts } from '../text.js';

/** The unit every price of this integration is expressed in (6 chars max). */
export const PRICE_UNIT = '€/L';

/** Decimals of a pump price: the roadside sign shows three (1.699). */
const PRICE_DECIMALS = 3;

/**
 * A price as text, with the decimal separator of the reader's language.
 * @param {number} price
 * @param {string} [language] ISO 639-1 sent by the core
 */
export function formatPrice(price, language = 'en') {
  if (!Number.isFinite(price)) {
    return '';
  }
  const text = price.toFixed(PRICE_DECIMALS);
  return language === 'fr' ? text.replace('.', ',') : text;
}

/**
 * A distance in kilometres, one decimal, same separator rule.
 * @param {number} km
 * @param {string} [language]
 */
export function formatDistance(km, language = 'en') {
  if (!Number.isFinite(km)) {
    return '';
  }
  const text = km.toFixed(1);
  return `${language === 'fr' ? text.replace('.', ',') : text} km`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The date a station declared its price, SHORT — because the ranking rows of
 * the dashboard live on one line, and a phone gives that line about half the
 * width a desktop does: `1,990 €/L · 22/09/2026 à 09:00` came back from mobile
 * cut at `1,990 €/L · 22/09/…`, which is the one part of the row that has to
 * stay readable (a stale price is normal, but only this date says so).
 *
 * So: the day, and the day only. `today` / `yesterday` while the price is
 * fresh, because that is the answer the reader is after; `22/09` inside the
 * current year; `22/09/24` beyond it, where the year stops being implied.
 * The hour is dropped on purpose — a pump price does not move twice in a day,
 * and the caption above already carries the minute WE read the feed.
 *
 * Parsed through `parseDateTimeParts`, textually, for the same reason
 * `formatDateTime` is: the container runs in UTC and a `new Date(...)` here
 * would turn a price declared at 00:30 in Paris into one declared the day
 * before.
 *
 * @param {unknown} value raw timestamp from the feed
 * @param {string} [language] ISO 639-1 sent by the core
 * @param {Date} [now] injectable clock, so a test does not depend on the day
 *   it runs on
 * @returns {string} `''` when there is no date to show
 */
export function formatShortDate(value, language = 'en', now = new Date()) {
  const parts = parseDateTimeParts(value);
  if (!parts) {
    // Unknown shape: the publisher's own string, like formatDateTime.
    return cleanText(value);
  }
  const { year, month, day } = parts;
  // Both sides reduced to a local midnight: what we compare is calendar days,
  // not the 24 hours between two instants.
  const declared = new Date(Number(year), Number(month) - 1, Number(day));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const elapsedDays = Math.round((today.getTime() - declared.getTime()) / DAY_MS);
  if (elapsedDays === 0) {
    return language === 'fr' ? 'auj.' : 'today';
  }
  if (elapsedDays === 1) {
    return language === 'fr' ? 'hier' : 'yest.';
  }
  if (Number(year) === today.getFullYear()) {
    return `${day}/${month}`;
  }
  return `${day}/${month}/${year.slice(2)}`;
}

/**
 * The full postal address of a station, as one line.
 * @param {{ address?: string, postalCode?: string, city?: string }} station
 */
export function stationAddress(station) {
  return [station.address, station.postalCode, station.city].filter(Boolean).join(' ').trim();
}

/**
 * A navigation link for a station — the one thing a driver wants once they know
 * where the cheapest pump is.
 *
 * `https` only (the core refuses anything else) and coordinates only: a station
 * of the French feed carries no name the map would resolve reliably, but it
 * always carries its GPS position.
 *
 * @param {{ latitude?: number, longitude?: number }} station
 * @returns {string|null} `null` when the station has no usable position
 */
export function directionsUrl(station) {
  if (!Number.isFinite(station?.latitude) || !Number.isFinite(station?.longitude)) {
    return null;
  }
  const destination = `${station.latitude.toFixed(5)},${station.longitude.toFixed(5)}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
}

/**
 * How wide a ranking row may let the station's name grow.
 *
 * The row of a `status` list is ONE line holding a label and a value, and the
 * front shares that line between the two: a long name does not just get its own
 * ellipsis, it squeezes the value until the value gets one too. That is how
 * `1,990 €/L · 22/09` came back from a phone as `1,990 €/L ·…`, with the date
 * gone although it was already as short as a date gets.
 *
 * So the NAME is bounded here — well under the 40 characters the core accepts —
 * and the price keeps its room whatever the station is called. 24 is what a
 * phone showed intact next to a price; the full name stays in the device list,
 * on the device page and in the "My station" card.
 */
export const ROW_LABEL_MAX = 24;

/** Shortest a segment may be shortened to before the whole name is cut instead. */
const MIN_SEGMENT = 5;

/**
 * A station name that fits a dashboard row, cut on ONE segment.
 *
 * A name is built as `brand - street - city` (src/countries/franceNames.js),
 * and the plain truncation the core would apply keeps the head only: "141
 * Boulevard Émile Zola - Oullins" becomes "141 Boulevard Émile Zo…", which
 * drops the one word telling that station from the same brand two towns away.
 *
 * So the whole overflow is paid by the LONGEST segment, and the others are left
 * alone: "TotalEnergies - Oullins-Pierre-Bénite" keeps its brand and shortens
 * the town, "141 Boulevard Émile Zola - Oullins" keeps its town and shortens the
 * street. When even that is not enough — three segments for the width of two —
 * the name is cut once at the end, because one legible name beats three stumps.
 *
 * @param {unknown} name
 * @param {number} [max] characters the whole name may occupy
 * @returns {string}
 */
export function shortenStationName(name, max = ROW_LABEL_MAX) {
  const text = cleanText(name);
  if (text.length <= max) {
    return text;
  }
  const segments = text.split(' - ');
  let longest = 0;
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].length > segments[longest].length) {
      longest = i;
    }
  }
  const budget = segments[longest].length - (text.length - max);
  if (segments.length < 2 || budget < MIN_SEGMENT) {
    return truncateSegment(text, max);
  }
  return segments
    .map((segment, i) => (i === longest ? truncateSegment(segment, budget) : segment))
    .join(' - ');
}

/** `Oullins-Pierre-Bénite` in 8 characters is `Oullins…` — the ellipsis counts. */
function truncateSegment(segment, max) {
  if (segment.length <= max) {
    return segment;
  }
  return `${segment.slice(0, max - 1).trimEnd()}…`;
}

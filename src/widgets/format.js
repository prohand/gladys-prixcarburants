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
 * on the device page and in the "My station" card. A wide screen has room for
 * more, but the widget content is the same on every screen (the core sends no
 * viewport and the front cuts with CSS), so what a phone can hold is what
 * everybody gets — the budget is spent on telling the stations APART instead.
 */
export const ROW_LABEL_MAX = 24;

/** How a station name joins its brand, its street and its city. */
const SEPARATOR = ' - ';

/** What the brand keeps at the very least, so `Total.` never becomes `T…`. */
const MIN_SEGMENT = 6;

/** Letters an abbreviated word keeps before its dot: `Access` -> `Acc.` */
const MIN_WORD = 3;

/**
 * Words above which a segment is cut rather than abbreviated.
 *
 * A brand is one or two words and survives being abbreviated ("TotalEnergies
 * Access" -> "TotalEn. Acc."); a street is four and does not ("141 Boulevard
 * Émile Zola" -> "141 Bou. Émi. Zola", which reads as noise where
 * "141 Boulevard…" still reads as an address).
 */
const MAX_ABBREVIATED_WORDS = 2;

/**
 * A station name that fits a dashboard row, cut where it costs the least.
 *
 * A name is built as `brand - city`, or `brand - street - city` when two
 * stations of the brand share a town (src/countries/franceNames.js). The plain
 * truncation the core would apply keeps the HEAD, which is the brand — so five
 * stations of the same chain came back as five rows reading
 * "TotalEnergies Access -…", telling the reader nothing but what they already
 * knew. The name of the brand is not what tells two pumps apart; where they
 * stand is.
 *
 * So the place is served FIRST and the brand pays, in this order:
 *   - the brand is abbreviated word by word from the end — "TotalEnergies
 *     Access" becomes "TotalEn. Acc." — which keeps a readable sign where a cut
 *     would leave a stump;
 *   - if abbreviating is still not enough, the brand is cut, and only then does
 *     the place start losing characters;
 *   - a middle segment is dropped rather than hacked: three stumps in 24
 *     characters name nothing. `buildRowLabels` brings that street back for the
 *     rows that actually need it.
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
  const segments = text.split(SEPARATOR);
  if (segments.length === 1) {
    return fitSegment(text, max);
  }
  // Two segments at most: the head the driver reads, and the place that tells
  // this station from the next one of the same chain.
  return fitPair(segments[0], segments[segments.length - 1], max);
}

/**
 * Station names shortened for the rows of one ranking, none of them twice.
 *
 * `shortenStationName` works on one name and cannot know that the row above
 * ends up reading the same thing: two "TotalEnergies Access - Lyon 7e" a street
 * apart become one label written twice, which is exactly the row a reader
 * cannot act on. The full names are already unique (`disambiguateStationNames`
 * sees to it), so a clash here is something WE cut off — and what we cut off is
 * the segment that made them different.
 *
 * So a clashing group is rebuilt around its FIRST differing segment: the street
 * when the brand and the city are shared, the city alone when the city itself
 * is what got truncated. Best effort, like every other display rule here: names
 * that stay equal are left equal rather than padded with a number nobody asked
 * for.
 *
 * @param {Array<unknown>} names in row order
 * @param {number} [max] characters a label may occupy
 * @returns {string[]} one label per name, same order
 */
export function buildRowLabels(names, max = ROW_LABEL_MAX) {
  const labels = names.map((name) => shortenStationName(name, max));
  const groups = new Map();
  labels.forEach((label, index) => {
    const group = groups.get(label);
    if (group) {
      group.push(index);
    } else {
      groups.set(label, [index]);
    }
  });

  for (const indexes of groups.values()) {
    if (indexes.length < 2) {
      continue;
    }
    const segmented = indexes.map((index) => cleanText(names[index]).split(SEPARATOR));
    const differing = firstDifferingSegment(segmented);
    if (differing === -1) {
      // Same name twice: nothing was lost in the cut, so nothing can be won back.
      continue;
    }
    indexes.forEach((index, rank) => {
      const segments = segmented[rank];
      const place = segments[segments.length - 1];
      const head = segments[Math.min(differing, segments.length - 1)];
      labels[index] = head === place ? fitSegment(place, max) : fitPair(head, place, max);
    });
  }

  return labels;
}

/**
 * The index of the first segment two of these names disagree on.
 * @param {string[][]} segmented
 * @returns {number} -1 when the names are identical segment for segment
 */
function firstDifferingSegment(segmented) {
  const longest = Math.max(...segmented.map((segments) => segments.length));
  for (let i = 0; i < longest; i += 1) {
    const first = segmented[0][i];
    if (segmented.some((segments) => segments[i] !== first)) {
      return i;
    }
  }
  return -1;
}

/**
 * `head - place` inside `max` characters, the place served first.
 * @param {string} head
 * @param {string} place
 * @param {number} max
 */
function fitPair(head, place, max) {
  const budget = max - SEPARATOR.length;
  // What is left once the place is whole — never less than a readable brand.
  const headBudget = Math.max(MIN_SEGMENT, budget - place.length);
  const shortHead = fitSegment(head, headBudget);
  return `${shortHead}${SEPARATOR}${truncateSegment(place, budget - shortHead.length)}`;
}

/**
 * One segment inside `max` characters: abbreviated if that is enough, cut
 * otherwise.
 *
 * The two are alternatives, not steps: "141 Bou. Émi…" is a worse address than
 * "141 Boulevard…", so abbreviating is only worth it when it makes the whole
 * segment fit, and only on the short segments a brand is made of.
 *
 * @param {string} segment
 * @param {number} max
 */
function fitSegment(segment, max) {
  if (segment.length <= max) {
    return segment;
  }
  if (segment.split(' ').length > MAX_ABBREVIATED_WORDS) {
    return truncateSegment(segment, max);
  }
  const abbreviated = abbreviateWords(segment, max);
  return abbreviated.length <= max ? abbreviated : truncateSegment(segment, max);
}

/**
 * Shorten the words of a segment, from the END, until it fits.
 *
 * The last words of a brand are its qualifiers ("Access", "Express", "Relais"),
 * so they are the ones that can lose letters without the sign becoming
 * unrecognisable: "TotalEnergies Access" in 14 characters is "TotalEn. Acc.",
 * which a driver still reads as their station.
 *
 * @param {string} segment
 * @param {number} budget
 * @returns {string} the shortest form this segment has, which may still exceed
 *   the budget when every word is already at its minimum
 */
function abbreviateWords(segment, budget) {
  const words = segment.split(' ');
  let text = words.join(' ');
  for (let i = words.length - 1; i >= 0 && text.length > budget; i -= 1) {
    const word = words[i];
    // A word of four letters gains nothing from a dot replacing one of them.
    if (word.length <= MIN_WORD + 1 || word.endsWith('.')) {
      continue;
    }
    const keep = Math.max(MIN_WORD, word.length - 1 - (text.length - budget));
    words[i] = `${word.slice(0, keep)}.`;
    text = words.join(' ');
  }
  return text;
}

/** `Oullins-Pierre-Bénite` in 8 characters is `Oullins…` — the ellipsis counts. */
function truncateSegment(segment, max) {
  if (segment.length <= max) {
    return segment;
  }
  if (max <= 1) {
    return '…';
  }
  // Trailing punctuation before an ellipsis reads as a typo ("Émi.…").
  return `${segment.slice(0, max - 1).replace(/[\s.,-]+$/u, '')}…`;
}

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
 * Words above which a segment is cut rather than compacted.
 *
 * A brand is one or two words and survives being compacted ("TotalEnergies
 * Access" -> "Total Access" -> "Total Acc." -> "Total"); a street is three or
 * four and does not — "141 Boulevard" reads as a street called Boulevard,
 * where "141 Boulevard…" says plainly that something was cut.
 */
const MAX_COMPACTED_WORDS = 2;

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
 * So the place is served FIRST and the brand pays for it — but it is never
 * dropped, because a row naming no brand names no station either. It is
 * compacted instead, and a middle segment is dropped rather than left as a
 * third stump: `buildRowLabels` brings that street back, next to the brand,
 * for the rows that actually need it.
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
    // No brand to tell from a place here: whatever this is, it is cut, never
    // compacted — an abbreviation invents a name the sign does not carry.
    return truncateSegment(text, max);
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
 * cannot act on. The full names are already unique
 * (`disambiguateStationNames`), so a clash here is something WE cut off — and
 * what we cut off is the segment that made them different.
 *
 * So a clashing group is rebuilt around its FIRST differing segment, KEEPING
 * the brand in front of it: "Total - Av. Jean Jaurès" and "Total - Rue
 * Garibaldi" rather than the street alone, because a row that names no brand
 * names no station. The brand of a clashing group is compacted to the same
 * width on every row of that group, so the same chain does not read three ways
 * in three consecutive rows. The one place the brand does go is a group whose
 * CITY is what got truncated ("Saint-Germain-en-Laye" against
 * "Saint-Germain-lès-Corbeil"): there the brand is the part they share, and
 * the city is the part that has to be read whole.
 *
 * Best effort, like every other display rule here: names that stay equal are
 * left equal rather than padded with a number nobody asked for.
 *
 * @param {Array<unknown>} names in row order
 * @param {number} [max] characters a label may occupy
 * @returns {string[]} one label per name, same order
 */
export function buildRowLabels(names, max = ROW_LABEL_MAX) {
  const segmented = names.map((name) => cleanText(name).split(SEPARATOR));
  const labels = segmented.map((segments) => shortenStationName(segments.join(SEPARATOR), max));
  // Two passes, because they do not cost the same thing. The first reveals a
  // segment the label had dropped — the street — and keeps the brand; only
  // what is STILL written twice afterwards pays the second, which gives the
  // whole row to the place and loses the brand.
  revealDiscriminant(labels, segmented, max);
  widenPlace(labels, segmented, max);
  return labels;
}

/** The rows that ended up reading the same thing, grouped. */
function clashes(labels) {
  const groups = new Map();
  labels.forEach((label, index) => {
    const group = groups.get(label);
    if (group) {
      group.push(index);
    } else {
      groups.set(label, [index]);
    }
  });
  return [...groups.values()].filter((indexes) => indexes.length > 1);
}

/**
 * Rebuild a clashing row around the segment it differs by, brand in front.
 *
 * Only the rows that HAVE such a segment are touched: a name of two segments
 * clashing with a name of three has nothing more to show, and rewriting it
 * would cost it its brand for nothing.
 */
function revealDiscriminant(labels, segmented, max) {
  for (const indexes of clashes(labels)) {
    const differing = firstDifferingSegment(indexes.map((index) => segmented[index]));
    if (differing === -1) {
      // Same name twice: nothing was lost in the cut, so nothing can be won back.
      continue;
    }
    const revealing = indexes.filter((index) => differing < segmented[index].length - 1);
    if (revealing.length === 0) {
      continue;
    }
    // The same chain must not read two ways in two consecutive rows, so the
    // brand of the group is compacted to the narrowest width any of them has.
    const headBudget = Math.min(
      ...revealing.map((index) =>
        Math.max(MIN_SEGMENT, max - SEPARATOR.length - segmented[index][differing].length),
      ),
    );
    for (const index of revealing) {
      labels[index] = fitPair(segmented[index][0], segmented[index][differing], max, headBudget);
    }
  }
}

/**
 * Last resort for the rows that still read the same: their PLACE is what got
 * truncated ("Saint-Germain-en-Laye" against "Saint-Germain-lès-Corbeil"), so
 * it takes the whole row and the brand — the part they share — goes.
 */
function widenPlace(labels, segmented, max) {
  for (const indexes of clashes(labels)) {
    const places = indexes.map((index) => segmented[index][segmented[index].length - 1]);
    if (new Set(places).size === 1) {
      // The same place twice: widening it says nothing more, and would cost
      // these rows the brand they still name correctly.
      continue;
    }
    for (const index of indexes) {
      const segments = segmented[index];
      labels[index] = truncateSegment(segments[segments.length - 1], max);
    }
  }
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
 * @param {number} [headBudget] imposed width of the head, for a row that must
 *   match the rows around it
 */
function fitPair(head, place, max, headBudget) {
  const budget = max - SEPARATOR.length;
  // What is left once the place is whole — never less than a readable brand.
  const width = headBudget ?? Math.max(MIN_SEGMENT, budget - place.length);
  const shortHead = fitBrand(head, width);
  return `${shortHead}${SEPARATOR}${truncateSegment(place, budget - shortHead.length)}`;
}

/**
 * The head of a name inside `max` characters: compacted if that is enough, cut
 * otherwise.
 *
 * The two are alternatives, not steps: "141 Bou. Émi…" is a worse address than
 * "141 Boulevard…", so compacting is only worth it when it makes the whole
 * segment fit, and only on the one or two words a brand is made of — a name
 * built on a street has no brand to compact, and a street is cut like a place.
 *
 * @param {string} segment
 * @param {number} max
 */
function fitBrand(segment, max) {
  if (segment.length <= max) {
    return segment;
  }
  if (segment.split(' ').length > MAX_COMPACTED_WORDS) {
    return truncateSegment(segment, max);
  }
  const compacted = compactSegment(segment, max);
  return compacted.length <= max ? compacted : truncateSegment(segment, max);
}

/**
 * Shorten a brand, in the order that costs the reader the least.
 *
 *   1. its words are taken back to their root, where they have one:
 *      "TotalEnergies Access" -> "Total Access", which loses nothing at all;
 *   2. the last words are abbreviated — they are the qualifiers ("Access",
 *      "Express", "Contact") — so "Total Acc." still reads as the station;
 *   3. those qualifiers are dropped rather than reduced to a stump: "Total"
 *      names the chain, "Tot. Acc." names nothing.
 *
 * @param {string} segment
 * @param {number} budget
 * @returns {string} the shortest form this brand has, which may still exceed
 *   the budget when one word is already longer than the row
 */
function compactSegment(segment, budget) {
  const words = segment.split(' ').map(rootOfWord);
  const abbreviate = (i) => {
    const word = words[i];
    // A word of four letters gains nothing from a dot replacing one of them.
    if (word.length <= MIN_WORD + 1 || word.endsWith('.')) {
      return;
    }
    const keep = Math.max(MIN_WORD, word.length - 1 - (words.join(' ').length - budget));
    words[i] = `${word.slice(0, keep)}.`;
  };

  // The qualifiers first, from the end...
  for (let i = words.length - 1; i >= 1 && words.join(' ').length > budget; i -= 1) {
    abbreviate(i);
  }
  // ...then dropped altogether, which is still better than the stump reducing
  // the name of the chain itself would leave.
  while (words.join(' ').length > budget && words.length > 1) {
    words.pop();
  }
  if (words.join(' ').length > budget) {
    abbreviate(0);
  }
  return words.join(' ');
}

/**
 * The root of a compound word, where cutting costs nothing: "TotalEnergies" is
 * "Total" plus a suffix the sign itself writes as one word, and a driver reads
 * "Total" as their station. Only a lowercase-to-uppercase boundary counts —
 * cutting "Intermarché" anywhere would need a dot to say a cut happened.
 *
 * @param {string} word
 * @returns {string} the word itself when it has no such boundary
 */
function rootOfWord(word) {
  for (let i = MIN_WORD; i < word.length; i += 1) {
    if (isUpperCase(word[i]) && isLowerCase(word[i - 1])) {
      return word.slice(0, i);
    }
  }
  return word;
}

function isUpperCase(char) {
  return char !== char.toLowerCase() && char === char.toUpperCase();
}

function isLowerCase(char) {
  return char !== char.toUpperCase() && char === char.toLowerCase();
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

// -----------------------------------------------------------------------------
// Small formatting helpers shared by the two widgets.
//
// The core formats the NUMBERS it renders itself (a `value` tile receives a raw
// number and displays it in the account's locale). What it cannot format is the
// free text we compose — "1,699 €/L · 2,3 km" in one string — so those few
// places take the `language` the core sends with every `widget.get` and build
// the sentence in it.
// -----------------------------------------------------------------------------

import { cleanText, parseDateTimeParts, shortenAddress } from '../text.js';

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
 * viewport and the front cuts with CSS), so the integration cannot pick the
 * width by itself: 24 is the DEFAULT, and the `name_length` setting of the
 * ranking card lets the user trade it up to `ROW_LABEL_WIDEST` for the screens
 * they actually use — see `ROW_LABEL_LENGTHS`.
 */
export const ROW_LABEL_MAX = 24;

/** The widest a row label may get: what the core accepts for a status label. */
export const ROW_LABEL_WIDEST = 40;

/**
 * The widths the ranking card offers, as strings — a `select` value is one.
 * Steps of four: fewer than that is not a difference anybody sees on a screen.
 */
export const ROW_LABEL_LENGTHS = ['24', '28', '32', '36', '40'];

/** How a station name joins its brand, its street and its city. */
const SEPARATOR = ' - ';

/**
 * How a street joins the city it is in: `Garnier, Lyon`.
 *
 * A comma rather than the dash the rest of the name uses, for two characters
 * the street gets back and because that is how an address is written — the
 * dash separates the parts of a NAME, the comma says "in".
 */
const CITY_SEPARATOR = ', ';

/** What the brand keeps at the very least, so `Total.` never becomes `T…`. */
const MIN_SEGMENT = 6;

/**
 * The width a brand keeps at the very least: the NAME OF THE CHAIN, whole.
 *
 * `MIN_SEGMENT` alone let the widest street of a ranking set the width of the
 * brand for the whole chain, and a Vichy dashboard came back reading `Carre.`
 * on three rows and `Lecle.` on a fourth — five characters saved, and the one
 * word every driver recognises turned into a stump. So the first word of the
 * brand, taken to its root (`TotalEnergies` is `Total`), is never cut: the
 * street or the place pays instead. Only the qualifiers behind it (`Access`,
 * `Contact`) are compacted, as before.
 *
 * Bounded to half the row, so a chain with a very long name still leaves the
 * place a readable share of it. A head of more than two words is a street,
 * not a brand, and gets the plain minimum.
 *
 * @param {string} head the first segment of a name
 * @param {number} max characters the whole label may occupy
 */
function brandFloor(head, max) {
  const words = head.split(' ');
  if (words.length > MAX_COMPACTED_WORDS) {
    return MIN_SEGMENT;
  }
  const chain = rootOfWord(words[0]).length;
  return Math.max(MIN_SEGMENT, Math.min(chain, Math.floor(max / 2)));
}

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
 * The technical id `disambiguateStationNames` appends to a name it could not
 * tell apart any other way — `Total - Av. Tony Garnier - Lyon (69007008)`,
 * because the two pumps of that avenue declare the very same address.
 *
 * It belongs to the device name, where it is the only thing keeping two entries
 * of the device list distinct; it does not belong to a ranking row, where it is
 * eight digits spent saying nothing. Dropped from the row so the street can be
 * shown instead — but only when there IS a street to show, since "the code or
 * nothing" is still better answered by the code.
 */
const ID_SUFFIX = /\s*\([A-Za-z0-9][A-Za-z0-9_-]{2,}\)$/u;

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
 * Station names shortened for the rows of one ranking, none of them saying less
 * than the row above.
 *
 * `shortenStationName` works on one name and cannot know what the rows around
 * it end up reading. Two things go wrong when every row is cut on its own, and
 * both come from the last segment of a name being the CITY:
 *
 *   - two stations of the same chain a street apart become one label written
 *     twice ("Total Access - Lyon 7e"), which is the row a reader cannot act
 *     on;
 *   - and a city the size of Lyon does not locate a pump anyway — five rows
 *     reading "Lyon" say where the area is, not where the station is.
 *
 * So the rule is about the PLACE, not about the clash: a city named by one row
 * is what the reader is looking for ("Oullins-Pierre-Bénite" tells that station
 * from every other of the ranking), and a city named by SEVERAL rows tells them
 * nothing on its own — those rows show their street, brand still in front,
 * because a row that names no brand names no station either. The street comes
 * from the name when it carries one and from the station's own address
 * otherwise: the device name only spells the street out when two devices would
 * collide (src/countries/franceNames.js), the dashboard needs it as soon as a
 * city is shared.
 *
 * The city stays behind it whenever the row can hold the three of them, because
 * a street alone asks where it is and no other row answers — "Total - Av. Tony
 * Garnier" under "Total - La Mulatière" leaves the reader to guess that the
 * avenue is in Lyon. What pays for the room is the STREET, shortened by what
 * every other street of the city carries anyway (`Rue de Gerland, Lyon` ->
 * `Gerland, Lyon`), and it only pays that far: a shortening that would make two
 * rows read the same, or a city too long to leave a street any room, gives the
 * city up instead — see `revealSharedPlace`.
 *
 * The brand of a chain is compacted to ONE width across the rows that reveal
 * their street, so the same chain does not read three ways in three consecutive
 * rows. What is still written twice afterwards — two stations of the very same
 * address, or two cities truncated to the same text — pays `widenPlace`.
 *
 * Best effort, like every other display rule here: rows that stay equal are
 * left equal rather than padded with a number nobody asked for.
 *
 * @param {Array<{ name?: string, address?: string }>} stations in row order
 * @param {number} [max] characters a label may occupy
 * @returns {string[]} one label per station, same order
 */
export function buildRowLabels(stations, max = ROW_LABEL_MAX) {
  const segmented = stations.map(rowSegments);
  const labels = segmented.map((segments) => wholeLabel(segments, max));
  // Two passes, because they do not cost the same thing. The first reveals a
  // segment the label had dropped — the street — and keeps the brand; only
  // what is STILL written twice afterwards pays the second, which gives the
  // whole row to the place and loses the brand.
  revealSharedPlace(labels, segmented, max);
  widenPlace(labels, segmented, max);
  return labels;
}

/**
 * A row as `shortenStationName` cuts it — unless it holds WHOLE, street
 * included, in which case it is written the way the rows sharing a city are:
 * `Carrefour - Av. de Vichy, Saint-Yorre`. A wide `name_length` is what makes
 * that happen, and one ranking must not read `brand - street - city` on one row
 * and `brand - street, city` on the next.
 */
function wholeLabel(segments, max) {
  if (segments.length === 3) {
    const [head, street, place] = segments;
    const whole = `${head}${SEPARATOR}${street}${CITY_SEPARATOR}${place}`;
    if (whole.length <= max) {
      return whole;
    }
  }
  return shortenStationName(segments.join(SEPARATOR), max);
}

/**
 * The segments a row may show: `brand - street - city`, as far as the station
 * lets us build it.
 *
 * Two fixes on the name the device list uses. The street is INSERTED when the
 * name does not carry it, since that name spells it out only to keep two
 * devices apart — a ranking row needs it as soon as it shares its city. And the
 * technical id `disambiguateStationNames` appends when even the street is not
 * enough (`Total - Av. Tony Garnier - Lyon (69007008)`: two pumps of the same
 * avenue) is DROPPED, because eight digits name nothing to a driver — but only
 * once there is a street to show instead, since "the code or nothing" is still
 * better answered by the code.
 *
 * @param {{ name?: string, address?: string }} station
 * @returns {string[]}
 */
function rowSegments(station) {
  const segments = cleanText(station?.name).split(SEPARATOR);
  const street = shortenAddress(station?.address);
  const head = segments[0];
  // Nothing to insert behind a name that IS its address: a station with no
  // brand already shows its street as its head.
  if (segments.length === 2 && street && head !== street && head !== cleanText(station?.address)) {
    segments.splice(1, 0, street);
  }
  if (segments.length >= 3) {
    const place = segments[segments.length - 1].replace(ID_SUFFIX, '');
    if (place) {
      segments[segments.length - 1] = place;
    }
    segments[segments.length - 2] = titleCaseStreet(segments[segments.length - 2]);
  }
  return segments;
}

/**
 * The words a French street name does not capitalise, whatever the feed does.
 * Ignored on the first word, which always carries a capital.
 */
const LOWERCASE_WORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'au', 'aux', 'et']);

/** Below this length, an all-caps word is an abbreviation ("ZA"), not a shout. */
const MIN_TITLE_CASED = 3;

/**
 * A street the way it is written on the street, not the way the feed stores it.
 *
 * The national feed publishes addresses in capitals — "AVENUE TONY GARNIER",
 * "112/116 RUE DE GERLAND" — or all in lowercase ("rue des ailes"), which was
 * invisible while the street only appeared on a device page, and is a row
 * shouting (or mumbling) at the reader now that a shared city puts it on the
 * dashboard. Word by word, so an address the publisher DID case
 * is left alone and the abbreviations `shortenAddress` produces ("ZA", "Rd-Pt")
 * survive.
 *
 * @param {string} street
 * @returns {string}
 */
function titleCaseStreet(street) {
  return street
    .split(' ')
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && LOWERCASE_WORDS.has(lower)) {
        return lower;
      }
      // A word all in capitals or all in lowercase was never cased by anyone:
      // the feed stores "RUE DE GERLAND" as often as "rue des ailes". A word
      // that mixes both was, and is left alone.
      const uncased = word === word.toUpperCase() || word === lower;
      if (!uncased || word.length < MIN_TITLE_CASED) {
        return word;
      }
      // A hyphen and an apostrophe both join two names, and the second one
      // carries a capital too (Saint-Exupéry, d'Arcole) — except the elided
      // article itself, which stays lowercase like the other particles.
      return lower
        .replace(/(^|[-'’])(\p{L})/gu, (_, join, letter) => `${join}${letter.toUpperCase()}`)
        .replace(/^([DL])(['’])/u, (_, article, apostrophe) =>
          index > 0 ? article.toLowerCase() + apostrophe : article + apostrophe,
        );
    })
    .join(' ');
}

/**
 * The house number at the head of a street, with the `bis`/`ter` that may
 * follow it: `112/116 `, `141 `, `3 bis `.
 */
const HOUSE_NUMBER = /^[\d][\d\s/,-]*(?:bis|ter|quater)?\s+(?=\p{L})/iu;

/** Below this, what is left of a street once its number is gone says nothing. */
const MIN_STREET = 4;

/**
 * The street of a segmented name, which sits just before the city, in the room
 * a row can give it.
 *
 * A number is only worth its characters while the street it belongs to is
 * written whole: "112/116 Rue de…" locates nothing, where "Rue de Gerland"
 * locates the station and "112/116" is what the driver's map fills in. So the
 * number is dropped — and only then, and only if that is what makes the street
 * fit — rather than the name of the street being cut.
 *
 * @param {string[]} segments
 * @param {number} room the widest a row can be, brand included
 * @returns {string}
 */
function streetOf(segments, room) {
  const street = segments[segments.length - 2];
  if (street.length <= room) {
    return street;
  }
  const named = street.replace(HOUSE_NUMBER, '');
  return named.length >= MIN_STREET && named.length <= room ? named : street;
}

/**
 * Give their street to every row whose city is named by another row too — and
 * keep that city next to it whenever the row can still hold it.
 *
 * A row keeps its city alone while that city tells it apart; it gains its
 * street the moment a neighbour claims the same one, because from there the
 * city is the one thing the two rows agree on. But a street WITHOUT its city
 * ("Total - Av. Tony Garnier" next to "Total - La Mulatière") asks the reader
 * where that avenue is, and the ranking no longer says: the city was the only
 * row that carried it. So the row shows all three — brand, street, city — and
 * the street is what pays for the room, in the order that costs the reader the
 * least: written whole while it fits, then without the kind of way it is
 * ("Rue de Gerland" -> "Gerland"), then reduced to the name a local uses
 * ("Av. Tony Garnier" -> "Garnier"). A pump is found by its street NAME; "Av."
 * and "Rue de" are what every other street carries too.
 *
 * One form for the whole city group, never one per row, so "Total - Garnier,
 * Lyon" does not sit under "Total - Rue de la Gare, Lyon" as if the two said
 * the same kind of thing. And the city is dropped again — back to
 * "brand - street" — when even the shortest street form does not fit next to
 * it, or when shortening the streets would make two rows of the group read the
 * same: telling the rows APART comes first, since that is what a ranking is.
 * Without the city, the street is shortened the same way, only as far as the
 * brand needs to keep the name of its chain whole.
 */
function revealSharedPlace(labels, segmented, max) {
  const byPlace = new Map();
  segmented.forEach((segments, index) => {
    const place = segments[segments.length - 1];
    byPlace.set(place, [...(byPlace.get(place) ?? []), index]);
  });

  /** @type {Map<number, { street: string, place: string|null }>} */
  const plans = new Map();
  for (const [place, indexes] of byPlace) {
    // A name of two segments has no street to reveal: rewriting it would cost
    // it its brand for nothing.
    const revealing = indexes.length > 1 ? indexes.filter((i) => segmented[i].length >= 3) : [];
    if (revealing.length === 0) {
      continue;
    }
    // The widest a street can ever get is the row minus the brand of ITS row,
    // as short as it gets without cutting the name of the chain.
    const room = (index) => {
      const head = segmented[index][0];
      return max - SEPARATOR.length - fitBrand(head, brandFloor(head, max)).length;
    };
    const streets = new Map(revealing.map((i) => [i, streetOf(segmented[i], room(i))]));
    const withCity = fitStreets(
      revealing,
      streets,
      (index) => room(index) - CITY_SEPARATOR.length - place.length,
      place,
    );
    // No room for the city: the street alone, in the fullest form that lets
    // the brand keep its name — `Carrefour - Peupliers` rather than
    // `Carre. - Rue des Peupli…`.
    const alone = withCity ? null : fitStreets(revealing, streets, room, null);
    for (const index of revealing) {
      plans.set(index, {
        street: withCity?.get(index) ?? alone?.get(index) ?? streets.get(index),
        place: withCity ? place : null,
      });
    }
  }

  // One width per chain, across the whole ranking: a brand written "Total" on
  // one row and "Total Acc." on the next reads as two different stations.
  const budgets = new Map();
  for (const [index, plan] of plans) {
    const head = segmented[index][0];
    budgets.set(head, Math.min(budgets.get(head) ?? Infinity, brandRoom(head, plan, max)));
  }
  for (const [index, plan] of plans) {
    const head = segmented[index][0];
    const budget = budgets.get(head);
    labels[index] = plan.place
      ? `${fitBrand(head, budget)}${SEPARATOR}${plan.street}${CITY_SEPARATOR}${plan.place}`
      : fitPair(head, plan.street, max, budget);
  }
}

/**
 * What a row leaves to its brand once the place it names is written.
 * Never less than the name of the chain: `Carrefour` is a station, `Carre.`
 * is a typo.
 */
function brandRoom(head, plan, max) {
  const place = plan.place ? CITY_SEPARATOR.length + plan.place.length : 0;
  return Math.max(brandFloor(head, max), max - SEPARATOR.length - plan.street.length - place);
}

/**
 * The street of each row of a city group, in the fullest form that fits the
 * room of every row — or `null` when no form does.
 *
 * @param {number[]} indexes rows of the group that show a street
 * @param {Map<number, string>} streets their street, house number already gone
 * @param {(index: number) => number} room characters the street of a row may
 *   take, the brand and (when there is one) the city already paid for
 * @param {string|null} place the city written behind the street, if any —
 *   always whole, because a city cut down to "Villeurb…" locates no better
 *   than the street alone and costs the street the room it took
 * @returns {Map<number, string>|null}
 */
function fitStreets(indexes, streets, room, place) {
  if (indexes.some((index) => room(index) < MIN_STREET)) {
    return null;
  }
  const forms = new Map(indexes.map((index) => [index, streetForms(streets.get(index))]));
  const distinct = new Set(streets.values()).size;
  const levels = Math.max(...[...forms.values()].map((list) => list.length));
  for (let level = 0; level < levels; level += 1) {
    const shortened = new Map(
      indexes.map((index) => {
        const list = forms.get(index);
        return [index, list[Math.min(level, list.length - 1)]];
      }),
    );
    // A street shortened into the very name of the city ("Rue de Lyon" in
    // Lyon) would read "Lyon, Lyon" and locate nothing.
    const fits = (index) => {
      const street = shortened.get(index);
      return street.length <= room(index) && street.toLowerCase() !== place?.toLowerCase();
    };
    if (!indexes.every(fits)) {
      continue;
    }
    // Shortening two streets into one label would trade the answer for the
    // context: these rows keep their street whole instead.
    return new Set(shortened.values()).size < distinct ? null : shortened;
  }
  return null;
}

/**
 * The kind of way a street is, which every street of the city carries too:
 * `Rue`, `Av.`, `ZA`... with the particle that follows it.
 */
const STREET_TYPE =
  /^(?:rue|ruelle|av|avenue|bd|boulevard|ch|chemin|imp|impasse|all|all[ée]e|pl|place|qu|quartier|rte|route|rd-pt|rond[- ]point|za|zi|zac|cours|quai|voie|square|mont[ée]e|passage|traverse|faubourg|fbg|lieu-dit)\.?(?=\s|$)\s*/iu;

/** The particle between the kind of way and the name it carries. */
const STREET_PARTICLE = /^(?:de\s+la|de\s+l['’]|des|du|de|d['’]|la|le|les|l['’]|aux|au)\s*/iu;

/** The forms of a street name, from the fullest to the shortest. */
function streetForms(street) {
  const forms = [street];
  const named = cleanText(street.replace(STREET_TYPE, '').replace(STREET_PARTICLE, ''));
  if (named.length >= MIN_STREET && named !== street) {
    forms.push(named);
  }
  const last = lastName(forms[forms.length - 1]);
  if (last !== forms[forms.length - 1]) {
    forms.push(last);
  }
  return forms;
}

/** Below this, a word of a street name is a particle or a number, not a name. */
const MIN_NAME = 3;

/**
 * The end of a street name, which is the part a local says: "Tony Garnier" is
 * "Garnier", "Général de Gaulle" is "Gaulle". Stops on the last word that is a
 * name — a particle or a house number says nothing on its own — and gives back
 * the street untouched when it has no such word.
 */
function lastName(street) {
  const words = street.replace(/…$/u, '').split(' ').filter(Boolean);
  for (let i = words.length - 1; i >= 1; i -= 1) {
    const word = words[i];
    if (word.length >= MIN_NAME && /^\p{L}/u.test(word) && !STREET_PARTICLE.test(`${word} `)) {
      return words.slice(i).join(' ');
    }
  }
  return street;
}

/**
 * Last resort for the rows that still read the same: their PLACE is what got
 * truncated ("Saint-Germain-en-Laye" against "Saint-Germain-lès-Corbeil"), so
 * it takes the whole row and the brand — the part they share — goes.
 */
function widenPlace(labels, segmented, max) {
  const groups = new Map();
  labels.forEach((label, index) => {
    groups.set(label, [...(groups.get(label) ?? []), index]);
  });

  for (const indexes of [...groups.values()].filter((group) => group.length > 1)) {
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
 * `head - place` inside `max` characters, the place served first.
 * @param {string} head
 * @param {string} place
 * @param {number} max
 * @param {number} [headBudget] imposed width of the head, for a row that must
 *   match the rows around it
 */
function fitPair(head, place, max, headBudget) {
  const budget = max - SEPARATOR.length;
  // What is left once the place is whole — never less than the name of the
  // chain.
  const width = headBudget ?? Math.max(brandFloor(head, max), budget - place.length);
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

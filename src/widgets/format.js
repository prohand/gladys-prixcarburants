// -----------------------------------------------------------------------------
// Small formatting helpers shared by the two widgets.
//
// The core formats the NUMBERS it renders itself (a `value` tile receives a raw
// number and displays it in the account's locale). What it cannot format is the
// free text we compose — "1,699 €/L · 2,3 km" in one string — so those few
// places take the `language` the core sends with every `widget.get` and build
// the sentence in it.
// -----------------------------------------------------------------------------

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

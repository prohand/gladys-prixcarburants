// -----------------------------------------------------------------------------
// Country provider: FRANCE — WHERE a postal code is.
//
// The price feed has no "distance to a postal code" filter, so the radius search
// needs a centre. The obvious centre is the average position of the stations
// carrying that postal code — free, we already fetched them — but it only exists
// when the postal code HAS a station: with 67750 (Scherwiller) the feed knows
// none, the centre was null, and the radius search was skipped altogether. The
// user then saw an empty list and, worse, widening the radius changed nothing
// because there was no circle to widen.
//
// So when the feed cannot tell us where the postal code is, we ask the Base
// Adresse Nationale — the official French geocoder, free, no key, no account —
// for the municipalities that use it and take their centre.
//
// Best effort, like the station names: a geocoder that does not answer costs the
// user the stations AROUND their postal code, never the ones INSIDE it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { centroid, isValidPoint } from '../geo.js';
import { cleanText } from '../text.js';

const logger = createLogger({ name: 'provider-fr-geo' });

const GEOCODER_URL = 'https://api-adresse.data.gouv.fr/search/';
const REQUEST_TIMEOUT_MS = 10_000;
// A postal code can be shared by several communes (67750 is Scherwiller AND
// Dieffenthal): ask for enough results to see all of them, then average.
const RESULT_LIMIT = 20;

/** postal code -> centre, or null when the geocoder does not know it. */
const centreByPostalCode = new Map();

/**
 * The geographic centre of a French postal code.
 *
 * Cached for the life of the container, negative answers included: a commune
 * does not move, and a postal code the geocoder ignores will not start existing
 * between two discoveries. A request that FAILS is not cached, so a network
 * hiccup does not cost the user their radius search until the next restart.
 *
 * @param {string} postalCode
 * @returns {Promise<{ latitude: number, longitude: number }|null>}
 */
export async function geocodePostalCode(postalCode) {
  const cp = String(postalCode ?? '').trim();
  if (!/^\d{5}$/.test(cp)) {
    return null;
  }
  if (centreByPostalCode.has(cp)) {
    return centreByPostalCode.get(cp);
  }

  try {
    const centre = await fetchCentre(cp);
    centreByPostalCode.set(cp, centre);
    if (!centre) {
      logger.warn(`The geocoder does not know the postal code ${cp}`);
    }
    return centre;
  } catch (err) {
    // Not an error for the user: they still get the stations of their own
    // postal code, just not the ones around it.
    logger.warn(`Cannot locate the postal code ${cp} (${err.message})`);
    return null;
  }
}

/** Forget every geocoded postal code. Exposed for the tests. */
export function resetGeocodeCache() {
  centreByPostalCode.clear();
}

/**
 * @param {string} cp
 * @returns {Promise<{ latitude: number, longitude: number }|null>}
 */
async function fetchCentre(cp) {
  const url = new URL(GEOCODER_URL);
  url.searchParams.set('q', cp);
  // Communes only: an address whose street number happens to look like a postal
  // code would drag the centre kilometres away.
  url.searchParams.set('type', 'municipality');
  url.searchParams.set('limit', String(RESULT_LIMIT));

  logger.debug(`Request -> ${url.toString()}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} (${response.statusText})`);
  }

  const body = await response.json();
  const features = Array.isArray(body?.features) ? body.features : [];
  // The geocoder ranks by relevance, not by postal code: keep the communes that
  // really use this one, and fall back to the best match only when none does.
  const exact = features.filter((feature) => cleanText(feature?.properties?.postcode) === cp);
  const kept = exact.length > 0 ? exact : features.slice(0, 1);

  const points = kept.map(readPoint).filter(isValidPoint);
  return centroid(points);
}

/**
 * The coordinates of one GeoJSON feature, as our internal point shape.
 * @param {{ geometry?: { coordinates?: unknown } }} feature
 * @returns {{ latitude: number, longitude: number }}
 */
function readPoint(feature) {
  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates)) {
    return { latitude: NaN, longitude: NaN };
  }
  // GeoJSON: [longitude, latitude].
  const [longitude, latitude] = coordinates.map(Number);
  return { latitude, longitude };
}

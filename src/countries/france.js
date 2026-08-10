// -----------------------------------------------------------------------------
// Country provider: FRANCE
//
// Data source: the official open data of https://www.prix-carburants.gouv.fr,
// republished as a queryable API on data.economie.gouv.fr (Opendatasoft Explore
// v2.1). Free, no account, no API key. The "flux instantané" dataset is
// refreshed roughly every 10 minutes and holds every point of sale in France
// with its address, its coordinates and one price column per fuel.
//
// We query the API rather than downloading the ZIP/XML archive of
// prix-carburants.gouv.fr: it lets us fetch ONLY the stations around a postal
// code (a few kB) instead of unzipping the ~15 MB national file on a Raspberry
// Pi at every refresh.
//
// The parsing below is deliberately tolerant: the same dataset is mirrored on
// several portals with slightly different column shapes (flat `gazole_prix`
// columns, nested `prix` array, coordinates in degrees or in hundred-thousandths
// of a degree). Accepting all of them costs a few lines and avoids a broken
// integration the day the publisher changes a column.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { centroid, distanceKm, isValidPoint } from '../geo.js';
import { FUEL_KEYS } from '../fuels.js';
import { cleanText } from '../text.js';
import { buildStationName, resolveStationNames } from './franceNames.js';
import { geocodePostalCode } from './franceGeocode.js';

const logger = createLogger({ name: 'provider-fr' });

const DATASET = 'prix-des-carburants-en-france-flux-instantane-v2';
const API_URL = `https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/${DATASET}/records`;

// Opendatasoft caps a single page at 100 records.
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 15_000;
// A `where` clause with too many OR terms is rejected: refresh prices by
// batches of ids instead of one giant query.
const IDS_PER_QUERY = 25;

// How many records one radius query may bring back. The API answers in dataset
// order, NOT by distance, so anything beyond this is not "the farthest stations"
// but an arbitrary slice: a truncated circle silently drops stations that are
// right next door. Hence the concentric search below, which is built to stop
// well before this cap ever bites.
const RADIUS_MAX_RECORDS = PAGE_SIZE * 5;
// Radius of the first circle, then doubled until the one the user configured.
const FIRST_RING_KM = 5;

// Flat columns of the v2 model, per fuel key.
const PRICE_COLUMNS = {
  gazole: 'gazole',
  sp95: 'sp95',
  sp98: 'sp98',
  e10: 'e10',
  e85: 'e85',
  gplc: 'gplc',
};

// Labels used by the nested `prix` array of the historical model.
const NESTED_FUEL_NAMES = {
  gazole: 'gazole',
  sp95: 'sp95',
  sp98: 'sp98',
  e10: 'e10',
  e85: 'e85',
  gplc: 'gplc',
  gpl: 'gplc',
  gplc_prix: 'gplc',
};

/** Postal codes in France are always 5 digits. */
const POSTAL_CODE_PATTERN = /^\d{5}$/;

// What a driver reads on the roadside sign is the BRAND — "Auchan",
// "TotalEnergies", "Leclerc". The national feed does NOT publish it (see
// franceNames.js, which fetches it from a reference dataset), but the mirrors of
// the dataset do not all drop it, and a column we can read straight from the
// record saves a remote lookup. Try every known spelling, in this order.
const BRAND_COLUMNS = [
  'marque',
  'brand',
  'enseigne',
  'enseignes',
  'nom_station',
  'station_name',
  'nom',
  'name',
  'raison_sociale',
];

// Last resort: any column whose NAME mentions a brand, so the day the publisher
// renames the column the station name survives on its own.
const BRAND_COLUMN_PATTERN = /marque|brand|enseigne/i;

export const france = {
  code: 'FR',
  label: { en: 'France', fr: 'France' },
  // Shown as the postal code placeholder in the Configuration screen docs.
  postalCodeExample: '35000',
  fuels: FUEL_KEYS,
  attribution: {
    en: 'Data: prix-carburants.gouv.fr open data (Etalab licence).',
    fr: 'Données : open data prix-carburants.gouv.fr (licence Etalab).',
  },

  isValidPostalCode(postalCode) {
    return POSTAL_CODE_PATTERN.test(String(postalCode ?? '').trim());
  },

  /**
   * Find the petrol stations around a postal code.
   *
   * Two steps, because the dataset has no "distance to a postal code" filter:
   *   1. every station whose `cp` column equals the postal code;
   *   2. if a radius is asked for, the stations within that radius of the
   *      centre of the postal code.
   * The union is de-duplicated, sorted by distance and truncated.
   *
   * @param {{ postalCode: string, radiusKm?: number, limit?: number }} options
   * @returns {Promise<Station[]>}
   */
  async searchStations({ postalCode, radiusKm = 0, limit = 20 }) {
    const cp = String(postalCode ?? '').trim();
    if (!POSTAL_CODE_PATTERN.test(cp)) {
      throw new Error(`Invalid French postal code: "${cp}" (5 digits expected)`);
    }

    const inPostalCode = await queryStations(`cp = "${cp}"`, PAGE_SIZE);
    logger.debug(`${inPostalCode.length} station(s) in postal code ${cp}`);

    const byId = new Map(inPostalCode.map((station) => [station.id, station]));
    // The stations of the postal code give us its position for free. When it
    // has none — a village whose pumps are all in the next town — the feed
    // cannot say where the user lives, so the geocoder does: without it, a
    // postal code with no station of its own returned nothing at all, at any
    // radius.
    const center = centroid(inPostalCode) ?? (radiusKm > 0 ? await geocodePostalCode(cp) : null);

    if (radiusKm > 0 && center) {
      // Widening the search is a bonus, not the request: if the publisher
      // renames the geo column, the user must still get the stations of their
      // own postal code rather than an empty list.
      try {
        const around = await searchAround(center, radiusKm, limit);
        for (const station of around) {
          if (!byId.has(station.id)) {
            byId.set(station.id, station);
          }
        }
      } catch (err) {
        logger.warn(`Radius search failed, keeping the ${cp} stations only: ${err.message}`);
      }
    } else if (radiusKm > 0) {
      logger.warn(`Cannot locate the postal code ${cp}: searching around it is impossible`);
    }

    const stations = [...byId.values()];
    for (const station of stations) {
      station.distanceKm = center ? distanceKm(center, station) : null;
      // The stations of the requested postal code always come first, whatever
      // the geometry says: they are the ones the user asked for.
      station.inPostalCode = station.postalCode === cp;
    }

    stations.sort(compareByRelevance);
    // Only the stations we are about to show are worth a name lookup: the
    // radius search can bring back three hundred of them, the user sees twenty.
    return resolveStationNames(stations.slice(0, limit));
  },

  /**
   * Re-read the given stations (prices change, the rest does not).
   * @param {string[]} ids station ids as provided by the dataset
   * @returns {Promise<Station[]>}
   */
  async fetchStationsByIds(ids) {
    const cleanIds = [...new Set(ids.map(sanitizeId).filter(Boolean))];
    const stations = [];
    for (let i = 0; i < cleanIds.length; i += IDS_PER_QUERY) {
      const batch = cleanIds.slice(i, i + IDS_PER_QUERY);
      const where = batch.map((id) => `id = "${id}"`).join(' OR ');
      stations.push(...(await queryStations(where, PAGE_SIZE)));
    }
    // Names are cached after the first lookup, so refreshing the prices of a
    // station already discovered costs no extra request.
    return resolveStationNames(stations);
  },
};

/**
 * The stations around a point, searched in CONCENTRIC circles rather than in
 * one query of the full radius.
 *
 * The reason is the shape of the API: it answers a `within_distance` filter in
 * dataset order, and the dataset is ordered by station id — which in France
 * starts with the postal code. Asking for "everything within 10 km of Lyon" and
 * keeping the first few hundred records therefore does not drop the FARTHEST
 * stations, it drops the ones with the highest postal codes: an Auchan in 69230
 * disappeared while 69100 stations came through, and raising the radius made it
 * worse by adding competitors to the same truncated answer.
 *
 * Starting small and doubling fixes it without a bigger download: in a city the
 * first circle already holds more stations than the user asked for, and it is
 * complete, so the nearest ones are guaranteed to be among them. In the country
 * the circles grow until the configured radius, where few stations live anyway.
 *
 * @param {{ latitude: number, longitude: number }} center
 * @param {number} radiusKm the radius the user configured
 * @param {number} limit how many stations the caller will keep
 * @returns {Promise<Station[]>}
 */
async function searchAround(center, radiusKm, limit) {
  const byId = new Map();

  for (const ringKm of searchRings(radiusKm)) {
    const found = await queryStations(withinDistance(center, ringKm), RADIUS_MAX_RECORDS);
    for (const station of found) {
      byId.set(station.id, station);
    }
    logger.debug(`${found.length} station(s) within ${ringKm} km`);

    if (found.length >= RADIUS_MAX_RECORDS) {
      // Growing the circle can only bring back a differently truncated answer.
      logger.warn(`More than ${RADIUS_MAX_RECORDS} stations within ${ringKm} km: list truncated`);
      break;
    }
    if (found.length >= limit) {
      // The circle is complete and already holds more stations than the caller
      // keeps, so every station it will keep is inside it: a wider circle would
      // only add stations that the distance sort throws away.
      break;
    }
  }

  return [...byId.values()];
}

/**
 * The successive radii to try, from `FIRST_RING_KM` up to the configured one.
 * @param {number} radiusKm
 * @returns {number[]}
 */
function searchRings(radiusKm) {
  const rings = [];
  for (let ring = FIRST_RING_KM; ring < radiusKm; ring *= 2) {
    rings.push(ring);
  }
  rings.push(radiusKm);
  return rings;
}

/**
 * The Opendatasoft geo filter, on the `geom` point column of the dataset.
 * @param {{ latitude: number, longitude: number }} center
 * @param {number} radiusKm
 * @returns {string} an ODSQL `where` clause
 */
function withinDistance(center, radiusKm) {
  return (
    `within_distance(geom, geom'POINT(${center.longitude.toFixed(5)} ` +
    `${center.latitude.toFixed(5)})', ${radiusKm}km)`
  );
}

/**
 * Stations of the requested postal code first, then by distance, then by name
 * so the discovery list never shuffles between two scans.
 */
function compareByRelevance(a, b) {
  if (a.inPostalCode !== b.inPostalCode) {
    return a.inPostalCode ? -1 : 1;
  }
  const distanceA = a.distanceKm ?? Number.POSITIVE_INFINITY;
  const distanceB = b.distanceKm ?? Number.POSITIVE_INFINITY;
  if (distanceA !== distanceB) {
    return distanceA - distanceB;
  }
  return a.name.localeCompare(b.name);
}

/**
 * Run an ODSQL `where` clause against the dataset and parse the records.
 * Pages until `max` records are collected or the dataset is exhausted.
 * @param {string} where
 * @param {number} max
 * @returns {Promise<Station[]>}
 */
async function queryStations(where, max) {
  const stations = [];
  for (let offset = 0; offset < max; offset += PAGE_SIZE) {
    const url = new URL(API_URL);
    url.searchParams.set('where', where);
    url.searchParams.set('limit', String(Math.min(PAGE_SIZE, max - offset)));
    url.searchParams.set('offset', String(offset));

    logger.debug(`Request -> ${url.toString()}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      // Propagate: the caller decides between keeping the previous prices and
      // reporting the failure to the user.
      throw new Error(`prix-carburants API HTTP ${response.status} (${response.statusText})`);
    }

    const body = await response.json();
    const records = Array.isArray(body.results) ? body.results : [];
    stations.push(...records.map(parseStation).filter(Boolean));

    if (records.length < PAGE_SIZE) {
      break;
    }
  }
  return stations;
}

/**
 * @typedef {Object} Station
 * @property {string} id
 * @property {string} name
 * @property {string} brand
 * @property {string} address
 * @property {string} city
 * @property {string} postalCode
 * @property {number|null} latitude
 * @property {number|null} longitude
 * @property {number|null} [distanceKm]
 * @property {boolean} [inPostalCode]
 * @property {Record<string, number|null>} prices  price in EUR/L, per fuel key
 * @property {Record<string, string|null>} updatedAt ISO date of each price
 */

/**
 * Turn one API record into our internal station shape.
 * @param {Record<string, unknown>} record
 * @returns {Station|null} null when the record has no usable id
 */
export function parseStation(record) {
  const id = sanitizeId(record.id ?? record.station_id);
  if (!id) {
    return null;
  }

  const { latitude, longitude } = parseCoordinates(record);
  const address = cleanText(record.adresse ?? record.address);
  const city = cleanText(record.ville ?? record.city);
  const brand = parseBrand(record);
  const nested = parseNestedPrices(record);

  /** @type {Record<string, number|null>} */
  const prices = {};
  /** @type {Record<string, string|null>} */
  const updatedAt = {};
  for (const fuel of FUEL_KEYS) {
    const column = PRICE_COLUMNS[fuel];
    prices[fuel] = parsePrice(record[`${column}_prix`] ?? nested[fuel]?.price);
    updatedAt[fuel] = cleanText(record[`${column}_maj`] ?? nested[fuel]?.updatedAt) || null;
  }

  return {
    id,
    name: buildStationName({ id, brand, city, address }),
    brand,
    address,
    city,
    postalCode: cleanText(record.cp ?? record.postal_code),
    latitude,
    longitude,
    prices,
    updatedAt,
  };
}

/**
 * The brand of the station ("Auchan", "TotalEnergies", …), whatever the column
 * carrying it is called on the portal we are talking to. An empty column is not
 * an answer: we keep looking instead of stopping on it, which is what `??` on a
 * chain of columns used to do.
 *
 * @param {Record<string, unknown>} record
 * @returns {string} the brand, or '' when the record really carries none
 */
export function parseBrand(record) {
  for (const column of BRAND_COLUMNS) {
    const brand = cleanText(record[column]);
    if (brand) {
      return brand;
    }
  }
  // Unknown column name: accept any scalar column that claims to hold a brand.
  for (const [column, value] of Object.entries(record)) {
    if (typeof value === 'object' || !BRAND_COLUMN_PATTERN.test(column)) {
      continue;
    }
    const brand = cleanText(value);
    if (brand) {
      return brand;
    }
  }
  return '';
}

/**
 * The coordinates arrive either as a geo point column or as two numeric
 * columns, and the historical export expresses them in hundred-thousandths of
 * a degree (4811833 == 48.11833). Normalize everything to decimal degrees.
 * @param {Record<string, unknown>} record
 */
function parseCoordinates(record) {
  const point = record.geom ?? record.geo_point_2d ?? record.geopoint;
  let latitude = null;
  let longitude = null;

  if (Array.isArray(point?.coordinates)) {
    // GeoJSON: [longitude, latitude].
    [longitude, latitude] = point.coordinates.map(Number);
  } else if (point && typeof point === 'object') {
    latitude = Number(point.lat ?? point.latitude);
    longitude = Number(point.lon ?? point.lng ?? point.longitude);
  }

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    latitude = Number(record.latitude);
    longitude = Number(record.longitude);
  }

  // Degrees scaled by 1e5 in the raw export.
  if (Number.isFinite(latitude) && Math.abs(latitude) > 90) {
    latitude /= 100_000;
  }
  if (Number.isFinite(longitude) && Math.abs(longitude) > 180) {
    longitude /= 100_000;
  }

  const candidate = { latitude, longitude };
  return isValidPoint(candidate) ? candidate : { latitude: null, longitude: null };
}

/**
 * Historical model: a `prix` array (or its JSON string) holding one entry per
 * fuel. Indexed by our own fuel keys so the caller does not care which shape
 * the portal served.
 * @param {Record<string, unknown>} record
 * @returns {Record<string, { price: unknown, updatedAt: unknown }>}
 */
function parseNestedPrices(record) {
  let entries = record.prix;
  if (typeof entries === 'string') {
    try {
      entries = JSON.parse(entries);
    } catch {
      return {};
    }
  }
  if (!Array.isArray(entries)) {
    return {};
  }

  const byFuel = {};
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const rawName = String(entry.nom ?? entry['@nom'] ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    const fuel = NESTED_FUEL_NAMES[rawName];
    if (fuel) {
      byFuel[fuel] = {
        price: entry.valeur ?? entry['@valeur'] ?? entry.prix,
        updatedAt: entry.maj ?? entry['@maj'],
      };
    }
  }
  return byFuel;
}

/**
 * A price in EUR per litre. Some exports publish it in thousandths of an euro
 * (1699 instead of 1.699); nothing sold at a French pump costs 20 EUR/L, so the
 * threshold is a safe discriminator.
 * @param {unknown} value
 * @returns {number|null}
 */
export function parsePrice(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  let price = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }
  if (price > 20) {
    price /= 1000;
  }
  return Math.round(price * 1000) / 1000;
}

/**
 * Station ids come back from our own external ids, so keep the query safe from
 * anything that could escape the ODSQL string literal.
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeId(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '');
}

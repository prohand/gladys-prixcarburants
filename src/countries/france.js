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

const logger = createLogger({ name: 'provider-fr' });

const DATASET = 'prix-des-carburants-en-france-flux-instantane-v2';
const API_URL = `https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/${DATASET}/records`;

// Opendatasoft caps a single page at 100 records.
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 15_000;
// A `where` clause with too many OR terms is rejected: refresh prices by
// batches of ids instead of one giant query.
const IDS_PER_QUERY = 25;

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
   *      centre of the ones found in step 1.
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

    const center = centroid(inPostalCode);
    const byId = new Map(inPostalCode.map((station) => [station.id, station]));

    if (radiusKm > 0 && center) {
      // `within_distance` is the Opendatasoft geo filter; `geom` is the point
      // column of the dataset. Widening the search is a bonus, not the
      // request: if the publisher renames that column, the user must still get
      // the stations of their own postal code rather than an empty list.
      try {
        const where =
          `within_distance(geom, geom'POINT(${center.longitude.toFixed(5)} ` +
          `${center.latitude.toFixed(5)})', ${radiusKm}km)`;
        const around = await queryStations(where, PAGE_SIZE * 3);
        logger.debug(`${around.length} station(s) within ${radiusKm} km`);
        for (const station of around) {
          if (!byId.has(station.id)) {
            byId.set(station.id, station);
          }
        }
      } catch (err) {
        logger.warn(`Radius search failed, keeping the ${cp} stations only: ${err.message}`);
      }
    } else if (radiusKm > 0) {
      logger.warn(`No station found in postal code ${cp}: cannot widen the search around it`);
    }

    const stations = [...byId.values()];
    for (const station of stations) {
      station.distanceKm = center ? distanceKm(center, station) : null;
      // The stations of the requested postal code always come first, whatever
      // the geometry says: they are the ones the user asked for.
      station.inPostalCode = station.postalCode === cp;
    }

    stations.sort(compareByRelevance);
    return stations.slice(0, limit);
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
    return stations;
  },
};

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
  const brand = cleanText(record.marque ?? record.brand ?? record.enseigne ?? record.nom);
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
    // The dataset has no station name: the brand plus the city is the closest
    // thing to what a driver reads on the roadside sign.
    name: [brand, city].filter(Boolean).join(' - ') || address || `Station ${id}`,
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

/**
 * @param {unknown} value
 * @returns {string}
 */
function cleanText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

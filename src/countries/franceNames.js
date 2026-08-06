// -----------------------------------------------------------------------------
// Country provider: FRANCE — the NAME of a station.
//
// The price feed we read (prix-des-carburants-en-france-flux-instantane-v2)
// does NOT publish the name of the point of sale. Not under `marque`, not under
// `enseigne`, not under `nom`: the column simply does not exist in the national
// dataset, which carries the address of every station and nothing else to
// recognise it by. Trying harder on the record itself — more column spellings,
// a regex over the column names — cannot succeed, and that is why the Discovery
// tab still offered "141 Boulevard Émile Zola - Oullins-Pierre-Bénite" instead
// of the sign the driver actually looks for.
//
// The same information system is republished by Opendatasoft WITH the two
// columns the raw feed drops, `Nom` and `Marque`, keyed by the same national
// point-of-sale id. So we keep reading the prices from the official feed (the
// only one refreshed every ~10 min) and read the name from that reference
// dataset — a station changes its sign about once a decade, so it is fetched
// once per station and cached for the life of the container.
//
// Everything here is best effort: a station keeps its address-based name when
// the reference dataset is unreachable, or when it does not know that station.
// A missing sign must never cost the user their prices.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { cleanText } from '../text.js';

const logger = createLogger({ name: 'provider-fr-names' });

// Tried in order; the first one that answers with a name column wins. Both
// republish the national point-of-sale file, so one is the other's spare tyre.
const REFERENCE_DATASETS = [
  'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/prix_des_carburants_j_7/records',
  'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/prix-des-carburants-j-1/records',
];

const REQUEST_TIMEOUT_MS = 15_000;
// Same limit as the price queries: a `where` clause with too many OR terms is
// rejected by the API.
const IDS_PER_QUERY = 25;
const PAGE_SIZE = 100;
// A reference dataset that just failed is not probed again on every discovery:
// the user would pay the timeout each time for a name we already know we cannot
// get. Prices are unaffected either way.
const PROBE_RETRY_MS = 60 * 60 * 1000;

// The mirrors do not agree on the technical name of their columns (`nom` vs
// `name`, `id` vs `id_station`), and the labels shown on the portal are not
// what the API returns. Rather than hard-coding one spelling and breaking the
// day a mirror changes it, we read ONE record and recognise the columns on it.
const ID_COLUMNS = ['id', 'id_station', 'station_id', 'identifiant_station', 'identifiant'];
const BRAND_COLUMN_PATTERN = /marque|brand|enseigne/i;
const NAME_COLUMN_PATTERN = /^(nom|name|nom_station|station_name|libelle|raison_sociale)$/i;

/** station id -> brand ('' when the reference dataset does not know it). */
const namesById = new Map();
/** Columns of the reference dataset in use, or null while unknown. */
let layout = null;
/** In-flight probe, so ten concurrent lookups do not probe ten times. */
let probing = null;
let lastProbeFailure = 0;

/**
 * The name shown in the Discovery tab and in the "Preview the nearby stations"
 * result: the brand first — that is the sign the driver looks for — then the
 * city, which tells two Auchan apart. Without a brand we fall back to the
 * street, so a station stays distinguishable from the three others of the same
 * city instead of being listed as a bare city name.
 *
 * @param {{ id: string, brand?: string, city?: string, address?: string }} station
 * @returns {string}
 */
export function buildStationName({ id, brand, city, address }) {
  return [brand || address, city].filter(Boolean).join(' - ') || `Station ${id}`;
}

/**
 * Fill in the brand of the stations that have none, then (re)build their name.
 * Mutates and returns the stations it was given.
 *
 * @param {Array<object>} stations
 * @returns {Promise<Array<object>>}
 */
export async function resolveStationNames(stations) {
  const unknownIds = [
    ...new Set(
      stations
        .filter((station) => !station.brand && !namesById.has(station.id))
        .map((station) => station.id),
    ),
  ];

  if (unknownIds.length > 0) {
    try {
      await fetchNames(unknownIds);
    } catch (err) {
      // Not an error for the user: they still get their stations and their
      // prices, just under the address the price feed publishes.
      logger.warn(`Station names unavailable, keeping the address: ${err.message}`);
    }
  }

  for (const station of stations) {
    if (!station.brand) {
      station.brand = namesById.get(station.id) ?? '';
    }
    station.name = buildStationName(station);
  }
  return stations;
}

/**
 * Forget everything learned about the reference dataset. Exposed for the tests,
 * which must not inherit the cache (nor the probe cooldown) of the previous one.
 */
export function resetStationNames() {
  namesById.clear();
  layout = null;
  probing = null;
  lastProbeFailure = 0;
}

/**
 * Look up the given station ids in the reference dataset and cache what comes
 * back. An id the dataset does not know is cached as "no name" so we do not ask
 * again at every discovery.
 * @param {string[]} ids
 */
async function fetchNames(ids) {
  const columns = await resolveLayout();
  if (!columns) {
    return;
  }

  for (let i = 0; i < ids.length; i += IDS_PER_QUERY) {
    const batch = ids.slice(i, i + IDS_PER_QUERY);
    const where = batch
      .map((id) => `${columns.id} = ${literal(id, columns.idIsNumber)}`)
      .join(' OR ');
    const records = await queryRecords(columns.url, where, PAGE_SIZE);

    for (const record of records) {
      const id = cleanText(record[columns.id]);
      if (id) {
        namesById.set(id, readName(record, columns));
      }
    }
    for (const id of batch) {
      if (!namesById.has(id)) {
        namesById.set(id, '');
      }
    }
  }
  logger.debug(`${ids.length} station name(s) looked up`);
}

/**
 * The brand of the station, or its commercial name when the brand column is
 * empty — an independent station has a name and no sign.
 * @param {Record<string, unknown>} record
 * @param {{ brand: string|null, name: string|null }} columns
 * @returns {string}
 */
function readName(record, columns) {
  const brand = columns.brand ? cleanText(record[columns.brand]) : '';
  const name = columns.name ? cleanText(record[columns.name]) : '';
  return brand || name;
}

/**
 * The columns of the first reference dataset that answers, or null when none
 * does. Resolved once, then reused.
 * @returns {Promise<{ url: string, id: string, idIsNumber: boolean, brand: string|null, name: string|null }|null>}
 */
async function resolveLayout() {
  if (layout) {
    return layout;
  }
  if (Date.now() - lastProbeFailure < PROBE_RETRY_MS) {
    return null;
  }
  if (!probing) {
    probing = probeReferenceDatasets().finally(() => {
      probing = null;
    });
  }
  layout = await probing;
  if (!layout) {
    lastProbeFailure = Date.now();
  }
  return layout;
}

/**
 * Ask each reference dataset for one record and look at the columns it carries.
 * @returns {Promise<object|null>}
 */
async function probeReferenceDatasets() {
  for (const url of REFERENCE_DATASETS) {
    try {
      const [sample] = await queryRecords(url, null, 1);
      const columns = readLayout(sample, url);
      if (columns) {
        logger.info(`Station names read from ${url} (column "${columns.brand ?? columns.name}")`);
        return columns;
      }
      logger.warn(`${url} carries no station name column, trying the next reference dataset`);
    } catch (err) {
      logger.warn(`${url} is unreachable (${err.message}), trying the next reference dataset`);
    }
  }
  logger.warn('No reference dataset available: stations keep the name built from their address');
  return null;
}

/**
 * Recognise the id and name columns of a sample record.
 * @param {Record<string, unknown>|undefined} record
 * @param {string} url
 * @returns {object|null} null when the record cannot be joined or has no name
 */
function readLayout(record, url) {
  if (!record || typeof record !== 'object') {
    return null;
  }
  const columns = Object.keys(record);
  const id = ID_COLUMNS.find((candidate) => columns.includes(candidate));
  const brand = columns.find((column) => BRAND_COLUMN_PATTERN.test(column)) ?? null;
  const name = columns.find((column) => NAME_COLUMN_PATTERN.test(column)) ?? null;

  // Without an id column we cannot join on the price feed, and without a brand
  // or a name there is nothing to gain from this dataset.
  if (!id || (!brand && !name)) {
    return null;
  }
  return { url, id, idIsNumber: typeof record[id] === 'number', brand, name };
}

/**
 * An ODSQL literal. The column is typed on the portal side: quoting a numeric
 * id (or leaving a text one bare) makes the whole clause fail, so the type read
 * on the sample record decides.
 * @param {string} id
 * @param {boolean} isNumber
 * @returns {string}
 */
function literal(id, isNumber) {
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, '');
  return isNumber ? safe : `"${safe}"`;
}

/**
 * @param {string} baseUrl
 * @param {string|null} where
 * @param {number} limit
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function queryRecords(baseUrl, where, limit) {
  const url = new URL(baseUrl);
  if (where) {
    url.searchParams.set('where', where);
  }
  url.searchParams.set('limit', String(limit));

  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} (${response.statusText})`);
  }
  const body = await response.json();
  return Array.isArray(body.results) ? body.results : [];
}

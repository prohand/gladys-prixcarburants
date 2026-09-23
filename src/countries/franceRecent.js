// -----------------------------------------------------------------------------
// Country provider: FRANCE — the fuels a station sold RECENTLY.
//
// The instant feed tells "out of stock" from "not sold" with its rupture
// declarations (see src/availability.js), but it can also say nothing at all:
// a station lifts its SP98 rupture and has not typed its price back yet, and
// for a while the feed carries neither a price nor a rupture for that fuel.
// Read literally, that silence is "non vendu" — at a station whose SP98 pump
// the user fills up at every week (reported on 104/106 av. Médéric, Noisy-le-
// Grand: a temporary rupture on the 21st, nothing at all on the 23rd).
//
// The feed has no memory, so we borrow one: the daily history republished by
// Opendatasoft (one record per station per day, one price column per fuel).
// A fuel the feed is SILENT about, but that the station priced within the last
// `WINDOW_DAYS`, is a pump waiting for its price: out of stock, not "not sold".
// A DEFINITIVE rupture is never questioned — the station said it stopped.
//
// Best effort, like the names: an unreachable history leaves the feed's reading
// unchanged, and answers are cached so the refresh loop does not pay a request
// every ten minutes for a list that moves once a day.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { AVAILABILITY } from '../availability.js';
import { cleanText } from '../text.js';

const logger = createLogger({ name: 'provider-fr-recent' });

const HISTORY_URL =
  'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/prix-des-carburants-j-1/records';

// Long enough to cover a rupture of a few weeks, short enough that a pump the
// station really removed stops being offered within a month.
const WINDOW_DAYS = 30;
const REQUEST_TIMEOUT_MS = 15_000;
// Same limit as the price queries: a `where` clause with too many OR terms is
// rejected by the API.
const IDS_PER_QUERY = 25;
// The history is published once a day: re-reading it more often buys nothing.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// A history that just failed is not asked again on every pass.
const RETRY_MS = 60 * 60 * 1000;

// Price column of the history, per fuel key.
const HISTORY_COLUMNS = {
  gazole: 'price_gazole',
  sp95: 'price_sp95',
  sp98: 'price_sp98',
  e10: 'price_e10',
  e85: 'price_e85',
  gplc: 'price_gplc',
};

/** station id -> { fuels: Set<string>, at: number } */
const recentById = new Map();
let lastFailure = 0;

/**
 * Turn the fuels the feed is silent about into "out of stock" when the station
 * priced them recently. Mutates and returns the stations it was given.
 *
 * @param {Array<object>} stations stations in the internal shape
 * @param {(station: object) => string[]} silentFuelsOf the fuels of a station
 *   with neither a price nor a rupture in the feed
 * @returns {Promise<Array<object>>}
 */
export async function resolveRecentFuels(stations, silentFuelsOf) {
  const pending = stations.filter((station) => silentFuelsOf(station).length > 0);
  if (pending.length === 0) {
    return stations;
  }

  const now = Date.now();
  const staleIds = [
    ...new Set(
      pending
        .filter((station) => !(now - (recentById.get(station.id)?.at ?? 0) < CACHE_TTL_MS))
        .map((station) => station.id),
    ),
  ];
  if (staleIds.length > 0 && now - lastFailure >= RETRY_MS) {
    try {
      await fetchRecentFuels(staleIds, now);
    } catch (err) {
      lastFailure = now;
      // Not an error for the user: the feed's own reading stands.
      logger.warn(`Price history unavailable, a silent fuel stays "not sold": ${err.message}`);
    }
  }

  for (const station of pending) {
    const recent = recentById.get(station.id)?.fuels;
    for (const fuel of silentFuelsOf(station)) {
      if (recent?.has(fuel)) {
        station.availability[fuel] = AVAILABILITY.OUT_OF_STOCK;
        // The feed declared nothing, so there is no date to show.
        station.outOfStockSince[fuel] = null;
      }
    }
  }
  return stations;
}

/**
 * Forget everything learned. Exposed for the tests, which must not inherit the
 * cache (nor the retry cooldown) of the previous one.
 */
export function resetRecentFuels() {
  recentById.clear();
  lastFailure = 0;
}

/**
 * Ask the history which fuels each station priced within the window: one
 * grouped query per batch, `max()` of a price column being null only when the
 * station published no price for that fuel on any day of the window.
 * @param {string[]} ids sanitized station ids
 * @param {number} now
 */
async function fetchRecentFuels(ids, now) {
  const select = [
    'id',
    ...Object.entries(HISTORY_COLUMNS).map(([fuel, column]) => `max(${column}) as ${fuel}`),
  ].join(', ');

  for (let i = 0; i < ids.length; i += IDS_PER_QUERY) {
    const batch = ids.slice(i, i + IDS_PER_QUERY);
    const url = new URL(HISTORY_URL);
    url.searchParams.set('select', select);
    url.searchParams.set('group_by', 'id');
    url.searchParams.set(
      'where',
      `(${batch.map((id) => `id = "${id}"`).join(' OR ')}) AND update >= now(days=-${WINDOW_DAYS})`,
    );
    url.searchParams.set('limit', String(IDS_PER_QUERY));

    logger.debug(`Request -> ${url.toString()}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`price history HTTP ${response.status} (${response.statusText})`);
    }
    const body = await response.json();
    const records = Array.isArray(body.results) ? body.results : [];

    // A station the history does not know is cached too, as "nothing recent".
    for (const id of batch) {
      recentById.set(id, { fuels: new Set(), at: now });
    }
    for (const record of records) {
      const entry = recentById.get(cleanText(record.id));
      if (!entry) {
        continue;
      }
      for (const fuel of Object.keys(HISTORY_COLUMNS)) {
        if (Number(record[fuel]) > 0) {
          entry.fuels.add(fuel);
        }
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Station store: the single place that talks to the country providers.
//
// Why it exists: Gladys polls each device INDEPENDENTLY. With ten stations
// added, `onPoll` fires ten times in a row — ten HTTP requests for data that a
// single query returns. The store keeps a short-lived cache and, on a miss,
// refreshes every tracked station of the country in ONE batched request. The
// nine other polls that follow are then served from memory.
//
// It also remembers which stations the user actually added (`track` /
// `untrack`), so a refresh never fetches stations nobody watches.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { getProvider } from './countries/index.js';

const logger = createLogger({ name: 'station-store' });

const DEFAULT_TTL_MS = 5 * 60 * 1000; // the French feed is refreshed every ~10 min

const cacheKey = (country, stationId) => `${country}:${stationId}`;

/**
 * @param {{ ttlMs?: number, now?: () => number, resolveProvider?: (country: string) => object }} [options]
 *   `resolveProvider` is the seam the unit tests use to plug a fake country
 *   provider in place of a real HTTP call.
 */
export function createStationStore({
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
  resolveProvider = getProvider,
} = {}) {
  /** @type {Map<string, { station: object, fetchedAt: number }>} */
  const cache = new Map();
  /** @type {Map<string, { country: string, stationId: string }>} */
  const tracked = new Map();
  /** @type {Map<string, Promise<void>>} in-flight refresh per country */
  const refreshes = new Map();

  // When a provider call last SUCCEEDED, whatever it brought back. This is the
  // integration-wide "the data you see is this old" answer, and the only one
  // the per-station dates cannot give: a station that has not moved its prices
  // in a week legitimately shows a week-old date, so a stale date there says
  // nothing about the feed being reachable. Failed calls leave it untouched —
  // the point is precisely to let it age when the API is down.
  /** @type {number|null} */
  let lastFetchAt = null;

  function remember(country, stations) {
    lastFetchAt = now();
    for (const station of stations) {
      cache.set(cacheKey(country, station.id), { station, fetchedAt: lastFetchAt });
    }
  }

  function isFresh(entry) {
    return entry !== undefined && now() - entry.fetchedAt < ttlMs;
  }

  /**
   * Search the stations around the configured postal code. Results are cached
   * too: adding a station right after a scan then costs no extra request.
   * @param {{ country: string, postal_code: string, search_radius_km: number, max_stations: number }} config
   */
  async function search(config) {
    const provider = resolveProvider(config.country);
    const stations = await provider.searchStations({
      postalCode: config.postal_code,
      radiusKm: config.search_radius_km,
      limit: config.max_stations,
    });
    remember(provider.code, stations);
    return stations;
  }

  /** Declare that a station is watched by at least one Gladys device. */
  function track(country, stationId) {
    tracked.set(cacheKey(country, stationId), { country, stationId });
  }

  /** Forget a station: the user deleted the last device pointing at it. */
  function untrack(country, stationId) {
    const key = cacheKey(country, stationId);
    tracked.delete(key);
    cache.delete(key);
  }

  /**
   * Replace the whole tracked set, e.g. after reading the devices Gladys
   * already holds on (re)connection.
   * @param {Array<{ country: string, stationId: string }>} stations
   */
  function setTracked(stations) {
    tracked.clear();
    for (const { country, stationId } of stations) {
      track(country, stationId);
    }
  }

  /**
   * Fetch every tracked station of a country in one request. Concurrent calls
   * share the same promise, so a burst of polls triggers a single query.
   * @param {string} country
   */
  function refreshTracked(country) {
    const pending = refreshes.get(country);
    if (pending) {
      return pending;
    }

    const ids = [...tracked.values()]
      .filter((entry) => entry.country === country)
      .map((entry) => entry.stationId);

    if (ids.length === 0) {
      return Promise.resolve();
    }

    const promise = (async () => {
      const provider = resolveProvider(country);
      logger.debug(`Refreshing ${ids.length} station(s) for ${country}`);
      const stations = await provider.fetchStationsByIds(ids);
      remember(country, stations);
      // A station can legitimately disappear from the feed (closed for works):
      // leave the stale entry in place so the last known price survives, but
      // say it in the logs.
      const missing = ids.length - stations.length;
      if (missing > 0) {
        logger.warn(`${missing} station(s) missing from the ${country} feed`);
      }
    })().finally(() => refreshes.delete(country));

    refreshes.set(country, promise);
    return promise;
  }

  /**
   * The freshest known state of a station, refreshing the country batch when
   * the cached copy is too old.
   * @param {string} country
   * @param {string} stationId
   * @returns {Promise<object|null>} null when the provider does not know it
   */
  async function getStation(country, stationId) {
    const key = cacheKey(country, stationId);
    const cached = cache.get(key);
    if (isFresh(cached)) {
      return cached.station;
    }
    // Make sure the station we need is part of the batch, even if the device
    // was created a millisecond ago and `onDeviceCreated` has not run yet.
    track(country, stationId);
    await refreshTracked(country);
    return cache.get(key)?.station ?? null;
  }

  /** Cached station without triggering any network call (may be stale). */
  function peek(country, stationId) {
    return cache.get(cacheKey(country, stationId))?.station ?? null;
  }

  /** Force the next `getStation` to hit the network. */
  function invalidate() {
    cache.clear();
  }

  return {
    search,
    track,
    untrack,
    setTracked,
    refreshTracked,
    getStation,
    peek,
    invalidate,
    get trackedStations() {
      return [...tracked.values()];
    },
    /** Epoch (ms) of the last successful provider call, `null` before the first one. */
    get lastFetchAt() {
      return lastFetchAt;
    },
  };
}

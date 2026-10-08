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
 * @param {{ ttlMs?: number, searchTtlMs?: number, now?: () => number,
 *   resolveProvider?: (country: string) => object }} [options]
 *   `resolveProvider` is the seam the unit tests use to plug a fake country
 *   provider in place of a real HTTP call. `searchTtlMs` is how long a search
 *   RESULT (the list) is reused — the same five minutes as a station by
 *   default, half the TTL of the "cheapest around me" card (10 min) and well
 *   under the shortest refresh interval (10 min).
 */
export function createStationStore({
  ttlMs = DEFAULT_TTL_MS,
  searchTtlMs = ttlMs,
  now = Date.now,
  resolveProvider = getProvider,
  // Where the search circle is centred (the Gladys house, when the user asked
  // for it and located it). Default: nothing, and the provider falls back on
  // the centre of the postal code, exactly as before this existed.
  resolveCenter = async () => ({ center: null, source: 'postal_code' }),
} = {}) {
  /** @type {Map<string, { station: object, fetchedAt: number }>} */
  const cache = new Map();
  /** @type {Map<string, { country: string, stationId: string }>} */
  const tracked = new Map();
  /** @type {Map<string, Promise<void>>} in-flight refresh per country */
  const refreshes = new Map();
  /** @type {Map<string, Promise<object[]>>} in-flight search per search criteria */
  const searches = new Map();
  /** @type {Map<string, { country: string, stations: object[], at: number }>} last result per criteria */
  const searchResults = new Map();

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
      const key = cacheKey(country, station.id);
      // Only a search measures distances: the batched refresh of the tracked
      // stations reads them by id, from no centre. Keep what the last search
      // measured, or the station card loses its distance row a few minutes
      // after every search. `clear()` (new postal code) forgets it.
      const previous = cache.get(key)?.station;
      if (!Number.isFinite(station.distanceKm) && Number.isFinite(previous?.distanceKm)) {
        station.distanceKm = previous.distanceKm;
        station.inPostalCode = previous.inPostalCode;
      }
      cache.set(key, { station, fetchedAt: lastFetchAt });
    }
  }

  function isFresh(entry) {
    return entry !== undefined && now() - entry.fetchedAt < ttlMs;
  }

  /**
   * Search the stations around the configured postal code. Results are cached
   * too: adding a station right after a scan then costs no extra request.
   *
   * And the LIST is cached, for `searchTtlMs`: a cold search is a postal code
   * to geocode, one request per concentric circle and two lookups for the
   * names and the history — two to six requests that every pull of the
   * "cheapest around me" card used to pay again, on every dashboard, on every
   * re-pull a price nudge asks for. The cached list is served through the
   * station cache, so a station the refresh pass re-read since shows its NEW
   * price; only the stations nobody tracks keep the price of the search.
   * Dropped by `clear()` (the configuration changed) and `invalidate()` (the
   * user asked for a real read).
   *
   * Concurrent searches for the SAME criteria share one call, exactly like the
   * per-country refresh below. That is not a micro-optimization: the two
   * dashboard cards pull at the same moment, and a cold search walks concentric
   * circles with one HTTP request per ring — doing it twice side by side is how
   * a pull runs past the core's 15 s ack deadline and the card comes back
   * "data unavailable".
   *
   * @param {{ country: string, postal_code: string, search_radius_km: number, max_stations: number }} config
   */
  function search(config) {
    const key = [
      config.country,
      config.postal_code,
      config.search_radius_km,
      config.max_stations,
      // The centre of the circle: same postal code, another house, other
      // stations and other distances.
      config.search_center,
      config.house_name,
    ].join('|');
    const done = searchResults.get(key);
    if (done && now() - done.at < searchTtlMs) {
      return Promise.resolve(
        done.stations.map(
          (station) => cache.get(cacheKey(done.country, station.id))?.station ?? station,
        ),
      );
    }
    const pending = searches.get(key);
    if (pending) {
      return pending;
    }

    const promise = (async () => {
      const provider = resolveProvider(config.country);
      const { center } = await resolveCenter(config);
      const stations = await provider.searchStations({
        postalCode: config.postal_code,
        radiusKm: config.search_radius_km,
        limit: config.max_stations,
        center,
      });
      remember(provider.code, stations);
      // A copy: a caller sorting its answer must not reorder the cached one.
      searchResults.set(key, { country: provider.code, stations: [...stations], at: now() });
      return stations;
    })().finally(() => searches.delete(key));

    searches.set(key, promise);
    return promise;
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

  /**
   * Force the next `getStation` to hit the network. The entries stay, stale:
   * the distance a search measured survives the refresh (see `remember`).
   */
  function invalidate() {
    for (const entry of cache.values()) {
      entry.fetchedAt = Number.NEGATIVE_INFINITY;
    }
    searchResults.clear();
  }

  /** Forget every station: the search criteria changed, so did the distances. */
  function clear() {
    cache.clear();
    searchResults.clear();
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
    clear,
    get trackedStations() {
      return [...tracked.values()];
    },
    /** Epoch (ms) of the last successful provider call, `null` before the first one. */
    get lastFetchAt() {
      return lastFetchAt;
    },
  };
}

// -----------------------------------------------------------------------------
// Where the user lives: the coordinates of the Gladys houses.
//
// Gladys knows where the house is, and an integration may ask for it — the
// manifest declares `"location": true`, which the install screen shows to the
// user as an authorization contract, and the host API answers
// `GET /api/integration/v1/house` with `[{ id, name, selector, latitude,
// longitude }]`. An integration that did NOT declare it gets a 403, so the
// manifest field and this module go together (Gladys ≥ 4.85).
//
// The SDK does not wrap that route (0.13.0 is the latest and has no `getHouses`),
// so the call is made here with the same base URL and token the SDK already
// holds. Two things make it cheap and safe:
//   - the answer is CACHED for an hour: a house does not move, and the widgets
//     ask on every pull;
//   - every failure resolves to `null` rather than throwing. No house, no
//     coordinates, a 403 because an older core does not know the field: the
//     integration then simply measures from the postal code, which is what it
//     did before this existed.
//
// This is personal data. It is used for one thing — the centre of the search
// and the origin of the distances — and never published in a device, a state,
// a log line or a widget content.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'house' });

/** How long the coordinates are kept before asking again. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** The host API is on the integration prefix, not the user one. */
const HOUSE_PATH = '/api/integration/v1/house';

/** Timeout of the call: a widget pull must not hang on it. */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Compare two house names the way a user types them: trimmed, case-insensitive
 * and accent-insensitive, since "Résidence" and "residence" name one house.
 * @param {unknown} value
 */
function nameKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

/**
 * @param {object} gladys SDK instance (for `hostApiUrl` and `token`)
 * @param {{ fetchImpl?: Function, now?: () => number, ttlMs?: number }} [options]
 *   `fetchImpl` and `now` are the seams the tests use in place of the network
 *   and the clock.
 */
export function createHouseLocation(
  gladys,
  { fetchImpl, now = Date.now, ttlMs = CACHE_TTL_MS } = {},
) {
  /** @type {{ at: number, houses: object[] }|null} */
  let cached = null;
  /** @type {Promise<object[]>|null} */
  let inFlight = null;
  let warned = false;
  let missWarned = null;

  async function request() {
    const baseUrl = gladys?.hostApiUrl ?? process.env.GLADYS_HOST_API_URL;
    const token = gladys?.token ?? process.env.GLADYS_INTEGRATION_TOKEN;
    const doFetch = fetchImpl ?? fetch;
    if (!baseUrl || !token) {
      return [];
    }

    const response = await doFetch(`${baseUrl}${HOUSE_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      // 403 = `"location": true` missing from the manifest (or a core older
      // than 4.85). Say it ONCE: the widgets ask every pull, and a log line per
      // pull would drown everything else.
      if (!warned) {
        warned = true;
        logger.info(
          `The house coordinates are not available (HTTP ${response.status}): ` +
            'distances will be measured from the postal code.',
        );
      }
      return [];
    }

    const houses = await response.json();
    if (!Array.isArray(houses)) {
      return [];
    }
    // Every LOCATED house is kept, not just the first one: a Gladys install can
    // hold several (a home and a holiday house, a home and an office) and the
    // configuration names which one the distances start from.
    const located = houses
      .filter((house) => Number.isFinite(house?.latitude) && Number.isFinite(house?.longitude))
      .map((house) => ({
        name: house.name,
        latitude: house.latitude,
        longitude: house.longitude,
      }));
    if (located.length === 0) {
      if (!warned) {
        warned = true;
        logger.info(
          'No Gladys house has coordinates yet: distances will be measured from the postal code.',
        );
      }
    }
    return located;
  }

  /** The cached list, fetched at most once per TTL and shared between callers. */
  function list() {
    if (cached && now() - cached.at < ttlMs) {
      return Promise.resolve(cached.houses);
    }
    // Concurrent widget pulls share one call, like the station store does.
    inFlight ??= request()
      .catch((err) => {
        logger.debug(`House coordinates unavailable: ${err.message}`);
        return [];
      })
      .then((houses) => {
        cached = { at: now(), houses };
        inFlight = null;
        return houses;
      });
    return inFlight;
  }

  /**
   * The house the configuration names, among the located ones.
   *
   * No name configured, or a name that matches nothing: the first located house
   * wins, as it always did — a single-house install is the normal case and must
   * never have to fill a field in. A name that matches nothing is said ONCE,
   * with the names Gladys actually holds, because "it measures from the wrong
   * house" is otherwise invisible.
   *
   * @param {object[]} houses
   * @param {string} [preferredName]
   */
  function pick(houses, preferredName) {
    if (houses.length === 0) {
      return null;
    }
    const wanted = nameKey(preferredName);
    if (wanted.length === 0) {
      return houses[0];
    }
    const match = houses.find((house) => nameKey(house.name) === wanted);
    if (match) {
      return match;
    }
    if (missWarned !== wanted) {
      missWarned = wanted;
      logger.warn(
        `No Gladys house named "${preferredName}": distances are measured from "${houses[0].name}". ` +
          `Houses Gladys knows: ${houses.map((house) => house.name).join(', ')}.`,
      );
    }
    return houses[0];
  }

  return {
    /**
     * The located house to measure from, or `null` when there is none to be had.
     * Never throws: a failure is a fallback, not an error.
     * @param {string} [preferredName] the house named in the configuration
     * @returns {Promise<{ name: string, latitude: number, longitude: number }|null>}
     */
    async get(preferredName) {
      return pick(await list(), preferredName);
    },

    /**
     * The names of the located houses, for the Configuration screen: a field
     * where the user TYPES a house name is only usable if something tells them
     * what to type (the core resolves dynamic select options against devices
     * only, so the list cannot be offered in the form itself).
     * @returns {Promise<string[]>}
     */
    async names() {
      return (await list()).map((house) => house.name);
    },

    /** Forget the cached answer (the user may have just located their house). */
    invalidate() {
      cached = null;
      warned = false;
      missWarned = null;
    },
  };
}

/**
 * Where the search is centred, and where the distances are measured from.
 *
 * The postal code always drives WHICH stations the country provider looks at —
 * it is the key of the national dataset. This only decides the geometry: the
 * house when the user asked for it and Gladys knows where it is, the centre of
 * the postal code area otherwise.
 *
 * @param {object} config normalized configuration
 * @param {{ get: () => Promise<object|null> }} [house] the module above
 * @returns {Promise<{ center: object|null, source: 'house'|'postal_code' }>}
 */
export async function resolveSearchCenter(config, house) {
  if (config.search_center !== 'house' || !house) {
    return { center: null, source: 'postal_code' };
  }
  const located = await house.get(config.house_name);
  return located
    ? { center: { latitude: located.latitude, longitude: located.longitude }, source: 'house' }
    : { center: null, source: 'postal_code' };
}

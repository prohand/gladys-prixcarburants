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
 * @param {object} gladys SDK instance (for `hostApiUrl` and `token`)
 * @param {{ fetchImpl?: Function, now?: () => number, ttlMs?: number }} [options]
 *   `fetchImpl` and `now` are the seams the tests use in place of the network
 *   and the clock.
 */
export function createHouseLocation(
  gladys,
  { fetchImpl, now = Date.now, ttlMs = CACHE_TTL_MS } = {},
) {
  /** @type {{ at: number, house: object|null }|null} */
  let cached = null;
  /** @type {Promise<object|null>|null} */
  let inFlight = null;
  let warned = false;

  async function request() {
    const baseUrl = gladys?.hostApiUrl ?? process.env.GLADYS_HOST_API_URL;
    const token = gladys?.token ?? process.env.GLADYS_INTEGRATION_TOKEN;
    const doFetch = fetchImpl ?? fetch;
    if (!baseUrl || !token) {
      return null;
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
      return null;
    }

    const houses = await response.json();
    if (!Array.isArray(houses)) {
      return null;
    }
    // The first LOCATED house wins (the API sorts by name): most installs have
    // one, and a second home is not something a fuel price card can guess
    // between.
    const located = houses.find(
      (house) => Number.isFinite(house?.latitude) && Number.isFinite(house?.longitude),
    );
    if (!located) {
      if (!warned) {
        warned = true;
        logger.info(
          'No Gladys house has coordinates yet: distances will be measured from the postal code.',
        );
      }
      return null;
    }
    return {
      name: located.name,
      latitude: located.latitude,
      longitude: located.longitude,
    };
  }

  return {
    /**
     * The located house, or `null` when there is none to be had.
     * Never throws: a failure is a fallback, not an error.
     * @returns {Promise<{ name: string, latitude: number, longitude: number }|null>}
     */
    async get() {
      if (cached && now() - cached.at < ttlMs) {
        return cached.house;
      }
      // Concurrent widget pulls share one call, like the station store does.
      inFlight ??= request()
        .catch((err) => {
          logger.debug(`House coordinates unavailable: ${err.message}`);
          return null;
        })
        .then((house) => {
          cached = { at: now(), house };
          inFlight = null;
          return house;
        });
      return inFlight;
    },

    /** Forget the cached answer (the user may have just located their house). */
    invalidate() {
      cached = null;
      warned = false;
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
  const located = await house.get();
  return located
    ? { center: { latitude: located.latitude, longitude: located.longitude }, source: 'house' }
    : { center: null, source: 'postal_code' };
}

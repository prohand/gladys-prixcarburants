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
// The route is read through the SDK's `gladys.getHouses()`. Two things make it
// cheap and safe:
//   - the answer is CACHED for an hour: a house does not move, and the widgets
//     ask on every pull — a transient failure (network, 429, 5xx) for two
//     minutes only, so a blip does not cost an hour of wrong distances;
//   - every failure resolves to `null` rather than throwing. No house, no
//     coordinates, a 403 because an older core does not know the field: the
//     integration then simply measures from the postal code, which is what it
//     did before this existed.
//
// WHICH house is picked in a list since Gladys 5.2: the `house` field of the
// configuration (and the `house` setting of the "cheapest" card) is a
// `source: "houses"` select, so the core offers the houses by name and stores
// the house SELECTOR. The name typed in the free-text field of up to 2.3 is
// still honoured when nothing was picked.
//
// This is personal data. It is used for one thing — the centre of the search
// and the origin of the distances — and never published in a device, a state,
// a log line or a widget content.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { preferredHouse } from './config.js';

const logger = createLogger({ name: 'house' });

/** How long the coordinates are kept before asking again. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * How long a TRANSIENT failure is kept: a network error, a 429 or a 5xx while
 * the core restarts. Cached for the hour like an answer, it measured every
 * distance from the postal code for an hour after a blip. Not zero either: the
 * widgets ask on every pull, and a core that is down should not be asked by
 * each of them.
 */
const FAILURE_TTL_MS = 2 * 60 * 1000;

/** A refusal no retry can fix: the manifest or the core version decides it. */
const isDurableRefusal = (status) => status === 401 || status === 403 || status === 404;

/** Timeout of the call: a widget pull must not hang on it (the SDK waits 15 s). */
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
 * @param {{ getHouses: () => Promise<object[]> }} gladys SDK instance
 * @param {{ now?: () => number, ttlMs?: number, failureTtlMs?: number,
 *   timeoutMs?: number }} [options]
 *   `now` is the seam the tests use in place of the clock.
 */
export function createHouseLocation(
  gladys,
  {
    now = Date.now,
    ttlMs = CACHE_TTL_MS,
    failureTtlMs = FAILURE_TTL_MS,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = {},
) {
  /** @type {{ at: number, houses: object[], ttl: number }|null} */
  let cached = null;
  /** @type {Promise<object[]>|null} */
  let inFlight = null;
  let warned = false;
  let missWarned = null;

  /** `gladys.getHouses()`, given up after `timeoutMs` like a transient failure. */
  function readHouses() {
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error('timed out'), { transient: true })),
        timeoutMs,
      );
    });
    return Promise.race([gladys.getHouses(), timeout]).finally(() => clearTimeout(timer));
  }

  async function request() {
    if (typeof gladys?.getHouses !== 'function') {
      return [];
    }

    let houses;
    try {
      houses = await readHouses();
    } catch (err) {
      // The SDK throws a GladysApiError carrying the HTTP `status`; a network
      // error carries none.
      if (!isDurableRefusal(err?.status)) {
        // 429, 5xx, network: the core is busy or restarting. Kept briefly, see list().
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
          transient: true,
        });
      }
      // 403 = `"location": true` missing from the manifest (or a core older
      // than 4.85). Say it ONCE: the widgets ask every pull, and a log line per
      // pull would drown everything else.
      if (!warned) {
        warned = true;
        logger.info(
          `The house coordinates are not available (HTTP ${err.status}): ` +
            'distances will be measured from the postal code.',
        );
      }
      return [];
    }

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
        selector: house.selector,
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
    if (cached && now() - cached.at < cached.ttl) {
      return Promise.resolve(cached.houses);
    }
    // Concurrent widget pulls share one call, like the station store does.
    inFlight ??= request()
      .then(
        (houses) => ({ houses, ttl: ttlMs }),
        (err) => {
          // A network error or a busy core: the postal code serves meanwhile,
          // and the house is asked again in a couple of minutes, not an hour.
          logger.debug(`House coordinates unavailable for now: ${err.message}`);
          return { houses: [], ttl: failureTtlMs };
        },
      )
      .then(({ houses, ttl }) => {
        cached = { at: now(), houses, ttl };
        inFlight = null;
        return houses;
      });
    return inFlight;
  }

  /**
   * The house the configuration asks for, among the located ones: the SELECTOR
   * a `source: "houses"` select stores, or the name typed before that select
   * existed — matched loosely, trimmed, case- and accent-insensitive.
   *
   * Nothing asked, or a house that matches nothing (deleted since, or never
   * located): the first located house wins, as it always did — a single-house
   * install is the normal case and must never have to fill a field in. A miss
   * is said ONCE, with the names Gladys actually holds, because "it measures
   * from the wrong house" is otherwise invisible.
   *
   * @param {object[]} houses
   * @param {string} [preferred] a house selector or a house name
   */
  function pick(houses, preferred) {
    if (houses.length === 0) {
      return null;
    }
    const wanted = nameKey(preferred);
    if (wanted.length === 0) {
      return houses[0];
    }
    const match =
      houses.find((house) => house.selector === String(preferred).trim()) ??
      houses.find((house) => nameKey(house.name) === wanted);
    if (match) {
      return match;
    }
    if (missWarned !== wanted) {
      missWarned = wanted;
      logger.warn(
        `No located Gladys house "${preferred}": distances are measured from "${houses[0].name}". ` +
          `Houses Gladys knows: ${houses.map((house) => house.name).join(', ')}.`,
      );
    }
    return houses[0];
  }

  return {
    /**
     * The located house to measure from, or `null` when there is none to be had.
     * Never throws: a failure is a fallback, not an error.
     * @param {string} [preferred] the house selector (or name) the configuration asks for
     * @returns {Promise<{ name: string, selector: string, latitude: number, longitude: number }|null>}
     */
    async get(preferred) {
      return pick(await list(), preferred);
    },

    /**
     * The names of the located houses, for the preview message: it says which
     * house is in use among them (the select lists every house, located or not).
     * @returns {Promise<string[]>}
     */
    async names() {
      return (await list()).map((house) => house.name);
    },

    /**
     * Every located house, for the `station` card: one station sits near ONE
     * of them, and the house of the configuration may be the other one.
     * The coordinates stay in the process like the ones `get` returns.
     * @returns {Promise<Array<{ name: string, latitude: number, longitude: number }>>}
     */
    async all() {
      return list();
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
 * @returns {Promise<{ center: object|null, source: 'house'|'postal_code', houseName?: string }>}
 */
export async function resolveSearchCenter(config, house) {
  if (config.search_center !== 'house' || !house) {
    return { center: null, source: 'postal_code' };
  }
  const [located, names] = await Promise.all([
    house.get(preferredHouse(config)),
    typeof house.names === 'function' ? house.names() : [],
  ]);
  if (!located) {
    return { center: null, source: 'postal_code' };
  }
  return {
    center: { latitude: located.latitude, longitude: located.longitude },
    source: 'house',
    // The NAME of the house, only when Gladys holds several: "my home" is then
    // ambiguous, and a card measuring from the holiday house while the user
    // reads "my home" is exactly what a user reported. Never the coordinates.
    ...(names.length > 1 ? { houseName: located.name } : {}),
  };
}

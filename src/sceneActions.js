// -----------------------------------------------------------------------------
// Scene actions: what a Gladys scene can ASK this integration to do
// ("Integrations" category of the action picker).
//
// PREVIEW FEATURE, the other half of GladysAssistant/Gladys#3110 — see the
// header of src/sceneEvents.js for what "preview" costs here. Contract:
//   - the manifest declares `scene_actions` (key, fields, outputs, timeout);
//   - a scene reaching one makes the core send the WebSocket message
//     `external-integration.scene-action.run` with `{ key, fields }`, the
//     fields already resolved (scene variables substituted, defaults applied,
//     validated against the declaration);
//   - the handler answers with an object; only the DECLARED `outputs` keys are
//     kept, and the scene reads them as `{{<column>.<row>.<key>}}`.
//
// What belongs here: something a scene cannot do with the devices alone.
//   - `refresh_prices`   : read the feed NOW, so the next steps of the scene do
//                          not act on an hour-old price;
//   - `cheapest_station` : a ranking ACROSS the followed stations, which no
//                          device holds — the answer to "where do I fill up?";
//   - `price_report`     : the same comparison as a ready-to-send line of text,
//                          because a notification wants a sentence, not eight
//                          separate feature values.
//
// Outputs are SCALARS (the core caps strings and drops anything else), and an
// action is never a condition: `cheapest_station` answers `found: false`
// instead of throwing, so the scene can gate itself with the core's
// "only continue if" on that output.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { FUEL_KEYS, fuelLabel } from './fuels.js';
import { parseTargets } from './devices/index.js';
import { refreshAllDevices } from './refresh.js';
import { formatDateTime } from './text.js';

const logger = createLogger({ name: 'scene-actions' });

/** Declared action keys. Never renamed once published: the scenes store them. */
export const SCENE_ACTIONS_KEYS = {
  REFRESH_PRICES: 'refresh_prices',
  CHEAPEST_STATION: 'cheapest_station',
  PRICE_REPORT: 'price_report',
};

// How many stations `price_report` may list, whatever the scene asks for.
export const REPORT_LIMITS = { MIN: 1, MAX: 20, DEFAULT: 5 };

// The declaration as the code sees it — `test/manifest.test.js` checks the
// manifest says exactly the same thing, in both directions. `fields` are the
// parameters the scene author fills in, `outputs` the ONLY keys a scene can
// read back: the core drops everything else.
export const SCENE_ACTION_CONTRACT = {
  [SCENE_ACTIONS_KEYS.REFRESH_PRICES]: {
    fields: [],
    outputs: ['total', 'updated', 'failed'],
  },
  [SCENE_ACTIONS_KEYS.CHEAPEST_STATION]: {
    fields: ['fuel', 'refresh'],
    outputs: [
      'found',
      'station_name',
      'city',
      'address',
      'price',
      'distance_km',
      'updated_at',
      'station_count',
    ],
  },
  [SCENE_ACTIONS_KEYS.PRICE_REPORT]: {
    fields: ['fuel', 'max_stations'],
    outputs: ['text', 'station_count', 'cheapest_price'],
  },
};

/** The WebSocket message the core sends when a scene reaches one of our actions. */

/**
 * The fuel a scene asked for.
 *
 * The core validates the value against the declared options before sending it,
 * so this only guards the fallback: an empty field (an old scene saved before
 * the field existed) uses the first fuel the user configured, which is the one
 * they care about.
 *
 * @param {unknown} value
 * @param {object} config normalized configuration
 */
function askedFuel(value, config) {
  const fuel = String(value ?? '').toLowerCase();
  return FUEL_KEYS.includes(fuel) ? fuel : config.fuel_type[0];
}

/** `1,659 €/L` — a price as a French scene message writes it. */
function priceText(price) {
  return `${price.toFixed(3).replace('.', ',')} €/L`;
}

/**
 * The stations the user follows for one fuel, with their current price, sorted
 * from the cheapest to the dearest.
 *
 * Reads go through the store like everywhere else: the whole country is
 * batched in ONE request, so comparing eight stations inside a scene costs one
 * HTTP call, not eight.
 *
 * @param {object} gladys SDK instance
 * @param {{ store: object, fuel: string }} context
 * @returns {Promise<Array<{ station: object, price: number }>>}
 */
async function followedStations(gladys, { store, fuel }) {
  const targets = parseTargets(await gladys.getDevices()).filter((t) => t.fuel === fuel);
  const found = [];
  for (const { country, stationId } of targets) {
    let station;
    try {
      station = await store.getStation(country, stationId);
    } catch (err) {
      // One station missing from the feed must not fail the whole answer: the
      // scene gets the comparison of the ones that did answer.
      logger.warn(`Station ${stationId} unreadable for this scene action: ${err.message}`);
      continue;
    }
    const price = station?.prices?.[fuel];
    if (Number.isFinite(price)) {
      found.push({ station, price });
    }
  }
  return found.sort((a, b) => a.price - b.price);
}

/**
 * Read the open data feed now, without waiting for the next refresh.
 *
 * @param {object} gladys SDK instance
 * @param {object} fields resolved by the core (none declared)
 * @param {{ config: object, store: object, sceneEvents?: object }} context
 */
export async function refreshPrices(gladys, fields, { config, store, sceneEvents }) {
  const { total, updated, failures } = await refreshAllDevices(gladys, {
    config,
    store,
    force: true,
    sceneEvents,
  });
  return { total, updated, failed: failures.length };
}

/**
 * The cheapest of the stations the user follows, for one fuel.
 *
 * @param {object} gladys SDK instance
 * @param {{ fuel?: string, refresh?: boolean }} fields
 * @param {{ config: object, store: object, sceneEvents?: object }} context
 */
export async function cheapestStation(gladys, fields, context) {
  const { store } = context;
  const fuel = askedFuel(fields.fuel, context.config);

  // The scene asked for fresh prices: pay the HTTP call inside the declared
  // timeout rather than answering with what the last hourly pass left.
  if (fields.refresh === true) {
    await refreshPrices(gladys, {}, context);
  }

  const stations = await followedStations(gladys, { store, fuel });
  if (stations.length === 0) {
    // Not an error: the user follows no station for that fuel. `found` is what
    // the scene tests with "only continue if" — an action never aborts a scene
    // by itself.
    logger.info(`No followed station sells ${fuel}: nothing to compare`);
    return { found: false, station_count: 0 };
  }

  const [{ station, price }] = stations;
  return {
    found: true,
    station_name: station.name,
    city: station.city ?? '',
    address: [station.address, station.postalCode, station.city].join(' ').trim(),
    price,
    distance_km: Number.isFinite(station.distanceKm) ? Number(station.distanceKm.toFixed(1)) : 0,
    updated_at: formatDateTime(station.updatedAt?.[fuel]),
    station_count: stations.length,
  };
}

/**
 * The same comparison, as one line of text a notification can carry as is.
 *
 * @param {object} gladys SDK instance
 * @param {{ fuel?: string, max_stations?: number }} fields
 * @param {{ config: object, store: object }} context
 */
export async function priceReport(gladys, fields, context) {
  const fuel = askedFuel(fields.fuel, context.config);
  const limit = Math.min(
    REPORT_LIMITS.MAX,
    Math.max(REPORT_LIMITS.MIN, Number(fields.max_stations) || REPORT_LIMITS.DEFAULT),
  );

  const stations = await followedStations(gladys, { store: context.store, fuel });
  if (stations.length === 0) {
    return {
      text: `Aucune station suivie ne vend du ${fuelLabel(fuel, 'fr')}.`,
      station_count: 0,
    };
  }

  // French, like the name of the integration device and the fuel labels of the
  // triggers: this string goes straight into a notification, unedited.
  const lines = stations
    .slice(0, limit)
    .map(({ station, price }) => `${station.name} ${priceText(price)}`);
  return {
    text: `${fuelLabel(fuel, 'fr')} : ${lines.join(' · ')}`,
    station_count: stations.length,
    cheapest_price: stations[0].price,
  };
}

/** Action key -> handler, consumed by index.js and checked by the tests. */
export const SCENE_ACTIONS = {
  [SCENE_ACTIONS_KEYS.REFRESH_PRICES]: refreshPrices,
  [SCENE_ACTIONS_KEYS.CHEAPEST_STATION]: cheapestStation,
  [SCENE_ACTIONS_KEYS.PRICE_REPORT]: priceReport,
};

/**
 * Register every scene action handler on the SDK.
 *
 * `onSceneAction(key, cb)` acks for us: the resolved outputs on success, the
 * error message on a throw, "not implemented" for a key we do not handle. The
 * handler receives the fields already resolved by the core — scene variables
 * substituted, defaults applied, types validated — so there is nothing to
 * parse here.
 *
 * @param {object} gladys SDK instance
 * @param {{ handlers?: Record<string, Function>, context: () => object }} options
 *   `context` is a function so the handlers always read the CURRENT
 *   configuration, the one `onConfigUpdated` last stored.
 */
export function registerSceneActions(gladys, { handlers = SCENE_ACTIONS, context }) {
  for (const [key, handler] of Object.entries(handlers)) {
    gladys.onSceneAction(key, (fields) => handler(gladys, fields ?? {}, context()));
  }
  logger.info(`${Object.keys(handlers).length} scene action(s) registered`);
}

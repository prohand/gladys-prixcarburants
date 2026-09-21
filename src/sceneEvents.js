// -----------------------------------------------------------------------------
// Scene triggers: the events this integration fires into the Gladys scene
// editor ("Integrations" category of the trigger picker).
//
// PREVIEW FEATURE. The core side is GladysAssistant/Gladys#3110, not released
// yet: `scene_triggers` in the manifest, `POST /api/integration/v1/scene/event`
// to fire one. Everything here is therefore written to be HARMLESS on a Gladys
// that does not know the endpoint — the first 404 disables the publisher for
// the life of the container and the refresh pass carries on exactly as before.
//
// What belongs here and what does not
// -----------------------------------
// A price is a STATE: it is a device feature, it has a history, and "warn me
// when the diesel drops below 1.70 €" is already a `device.new-state` trigger
// with a threshold, in the core, with no integration code. Nothing here
// duplicates that.
//
// What a device feature cannot say is what HAPPENS between two reads:
//   - `price_updated`            : a station moved a price — carries the old
//                                  price, the new one and the difference, which
//                                  no single feature value holds;
//   - `cheapest_station_changed` : the cheapest of the stations you follow is
//                                  not the same one as before — a ranking
//                                  ACROSS devices, which no device owns;
//   - `feed_status_changed`      : the open data API stopped (or started)
//                                  answering — a transition, where the
//                                  integration device only shows a date ageing.
//
// Two rules the whole module obeys, both from the spec:
//   - ONE EVENT PER TRANSITION. Never one per refresh pass: a price that did
//     not move fires nothing, whatever the poll interval.
//   - NO BASELINE, NO EVENT. The first pass after a restart only records what
//     it sees; the container holds no state across restarts (the sandbox is
//     read-only), so firing on first sight would mean "everything changed"
//     every time the container is restarted.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { FUEL_KEYS, fuelLabel } from './fuels.js';
import { formatDateTime, formatInstant } from './text.js';

const logger = createLogger({ name: 'scene-events' });

/** Declared trigger keys. Part of the contract: NEVER renamed (scenes store them). */
export const SCENE_TRIGGERS = {
  PRICE_UPDATED: 'price_updated',
  CHEAPEST_STATION_CHANGED: 'cheapest_station_changed',
  FEED_STATUS_CHANGED: 'feed_status_changed',
};

/** Values of the `direction` filter of `price_updated`. */
export const PRICE_DIRECTIONS = { DOWN: 'down', UP: 'up' };

/** Values of the `status` filter of `feed_status_changed`. */
export const FEED_STATUSES = { AVAILABLE: 'available', UNAVAILABLE: 'unavailable' };

// The declaration, as the code sees it. The manifest must say exactly the same
// thing — `test/manifest.test.js` compares the two, in both directions, the way
// it already does for the actions and the fuel list.
//
// `filters` are the fields the scene author fills in (empty = any), `variables`
// the ONLY keys a scene can read as {{triggerEvent.data.<key>}}: the core drops
// everything else. A key may be in both lists (`fuel`, `direction`): filterable
// AND readable.
export const SCENE_TRIGGER_CONTRACT = {
  [SCENE_TRIGGERS.PRICE_UPDATED]: {
    filters: ['device', 'fuel', 'direction'],
    variables: [
      'station_name',
      'city',
      'fuel',
      'fuel_label',
      'price',
      'previous_price',
      'price_difference',
      'direction',
      'updated_at',
    ],
  },
  [SCENE_TRIGGERS.CHEAPEST_STATION_CHANGED]: {
    filters: ['fuel'],
    variables: [
      'station_name',
      'city',
      'fuel',
      'fuel_label',
      'price',
      'previous_station_name',
      'previous_price',
      'price_difference',
      'station_count',
    ],
  },
  [SCENE_TRIGGERS.FEED_STATUS_CHANGED]: {
    filters: ['status'],
    variables: ['status', 'error', 'last_success'],
  },
};

// A scene event carries strings of at most 1000 characters (400 BAD_REQUEST
// beyond). An error message chains causes and can be much longer than that.
const MAX_ERROR_LENGTH = 200;

// Prices are thousandths of a euro, and 1.699 - 1.722 is -0.023000000000000048
// in binary floating point. A scene printing that difference in a notification
// deserves the three decimals the pump displays, and nothing more.
const round3 = (value) => Math.round(value * 1000) / 1000;

/**
 * Fire one declared trigger.
 *
 * A thin wrapper on purpose: it is the single seam the tests replace
 * (`createSceneEvents(gladys, { publish })`), and the single place the key and
 * the payload can be logged the day one has to be traced.
 *
 * @param {object} gladys SDK instance
 * @param {string} key declared `scene_triggers[].key`
 * @param {Record<string, string|number|boolean|null>} data flat, primitives only
 */
export async function publishSceneEvent(gladys, key, data) {
  return gladys.publishSceneEvent(key, data);
}

/**
 * Cut an error message down to something a scene can carry.
 * @param {unknown} error
 */
function errorText(error) {
  if (!error) {
    return '';
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;
}

/**
 * The scene-event side of a refresh pass.
 *
 * Usage, from `refreshAllDevices`: open a pass, `record()` every station read
 * successfully, `end()` it once. Comparing a whole pass at once is what makes
 * "the cheapest station changed" answerable at all — it is a ranking across
 * devices, not a property of any one of them.
 *
 * @param {object} gladys SDK instance
 * @param {{ publish?: Function }} [options] `publish` is the seam the unit
 *   tests use in place of the real host API call.
 */
export function createSceneEvents(gladys, { publish = publishSceneEvent } = {}) {
  /** `country-stationId-fuel` -> last price seen. The baseline of `price_updated`. */
  const lastPrices = new Map();
  /** fuel -> the cheapest followed station of the previous pass. */
  const leaders = new Map();
  // Optimistic on purpose: a container that starts while the API is down fires
  // "unavailable" on its first failed pass, which is the whole point of the
  // trigger. A container that starts on a healthy feed fires nothing.
  let feedAvailable = true;
  // Flipped by the first 404: this Gladys does not know the route (the feature
  // is not released yet), or no longer declares the key. Either way, retrying
  // every hour would only fill the logs.
  let enabled = true;

  /**
   * Send one event, swallowing every failure: a scene trigger is a bonus on top
   * of a refresh pass, never a reason to fail one.
   * @param {string} key
   * @param {object} data
   */
  async function fire(key, data) {
    if (!enabled) {
      return false;
    }
    try {
      await publish(gladys, key, data);
      logger.debug(`Scene event fired: ${key}`);
      return true;
    } catch (err) {
      if (err?.status === 404) {
        enabled = false;
        logger.info(
          `This Gladys does not accept the "${key}" scene trigger (${err.message}): ` +
            'scene events are disabled until the next restart.',
        );
        return false;
      }
      // 429 (rate limit), a disconnected core, anything else: this pass loses
      // its event, the next one will fire the next transition.
      logger.warn(`Scene event "${key}" not delivered: ${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * The cheapest station of a fuel among the ones read in this pass.
   *
   * Below two stations there is no ranking to speak of, so the baseline is
   * dropped instead of being kept: following a single station must never fire
   * "the cheapest changed" the day a second one is added.
   *
   * @param {Array<object>} readings
   */
  function cheapest(readings) {
    return readings.reduce((best, reading) => (reading.price < best.price ? reading : best));
  }

  return {
    /**
     * Forget every baseline: the configuration changed, so the device set and
     * the stations behind it are not the ones the previous passes measured.
     */
    reset() {
      lastPrices.clear();
      leaders.clear();
      feedAvailable = true;
    },

    /** Is the publisher still trying? False once the core answered 404. */
    get enabled() {
      return enabled;
    },

    /** Open a refresh pass. */
    startPass() {
      /** @type {Array<object>} */
      const readings = [];

      return {
        /**
         * One station read successfully during this pass.
         * @param {{ device: object, target: object, station: object, price: number }} reading
         */
        record({ device, target, station, price }) {
          if (!Number.isFinite(price)) {
            return;
          }
          readings.push({ device, target, station, price });
        },

        /**
         * Close the pass and fire what actually changed.
         * @param {{ failed?: boolean, error?: unknown, lastSuccessAt?: number|null }} outcome
         *   `failed` is a pass where EVERY station failed — one station missing
         *   from the feed is not the API being down.
         * @returns {Promise<Array<{ key: string, data: object }>>} the events fired
         */
        async end({ failed = false, error = null, lastSuccessAt = null } = {}) {
          const fired = [];

          // 1. Prices that moved. The map is updated whether the event is
          //    delivered or not: a failed delivery must not make the NEXT pass
          //    fire the same transition again.
          for (const { device, target, station, price } of readings) {
            const key = `${target.country}-${target.stationId}-${target.fuel}`;
            const previous = lastPrices.get(key);
            lastPrices.set(key, price);
            if (previous === undefined || previous === price) {
              continue;
            }
            const data = {
              device: device.external_id,
              station_name: station.name,
              city: station.city ?? '',
              fuel: target.fuel,
              fuel_label: fuelLabel(target.fuel, 'fr'),
              price,
              previous_price: previous,
              price_difference: round3(price - previous),
              direction: price < previous ? PRICE_DIRECTIONS.DOWN : PRICE_DIRECTIONS.UP,
              updated_at: formatDateTime(station.updatedAt?.[target.fuel]),
            };
            if (await fire(SCENE_TRIGGERS.PRICE_UPDATED, data)) {
              fired.push({ key: SCENE_TRIGGERS.PRICE_UPDATED, data });
            }
          }

          // 2. The cheapest station of each fuel, among the ones followed.
          const byFuel = new Map();
          for (const reading of readings) {
            const list = byFuel.get(reading.target.fuel) ?? [];
            list.push(reading);
            byFuel.set(reading.target.fuel, list);
          }
          for (const fuel of FUEL_KEYS) {
            const list = byFuel.get(fuel) ?? [];
            if (list.length < 2) {
              leaders.delete(fuel);
              continue;
            }
            const winner = cheapest(list);
            const previous = leaders.get(fuel);
            leaders.set(fuel, {
              stationId: winner.target.stationId,
              name: winner.station.name,
              price: winner.price,
            });
            if (previous === undefined || previous.stationId === winner.target.stationId) {
              continue;
            }
            const data = {
              station_name: winner.station.name,
              city: winner.station.city ?? '',
              fuel,
              fuel_label: fuelLabel(fuel, 'fr'),
              price: winner.price,
              previous_station_name: previous.name,
              previous_price: previous.price,
              price_difference: round3(winner.price - previous.price),
              station_count: list.length,
            };
            if (await fire(SCENE_TRIGGERS.CHEAPEST_STATION_CHANGED, data)) {
              fired.push({ key: SCENE_TRIGGERS.CHEAPEST_STATION_CHANGED, data });
            }
          }

          // 3. The feed itself, on transition only.
          const available = !failed;
          if (available !== feedAvailable) {
            feedAvailable = available;
            const data = {
              status: available ? FEED_STATUSES.AVAILABLE : FEED_STATUSES.UNAVAILABLE,
              error: available ? '' : errorText(error),
              last_success: formatInstant(lastSuccessAt),
            };
            if (await fire(SCENE_TRIGGERS.FEED_STATUS_CHANGED, data)) {
              fired.push({ key: SCENE_TRIGGERS.FEED_STATUS_CHANGED, data });
            }
          }

          return fired;
        },
      };
    },
  };
}

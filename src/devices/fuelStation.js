// -----------------------------------------------------------------------------
// Device type: FUEL STATION
//
// One Gladys device = one petrol station AND one fuel. "TotalEnergies Rennes,
// Diesel" and "TotalEnergies Rennes, SP98" are two devices: a Gladys device
// keeps the features it was created with, so binding the fuel to the device id
// is what lets a user change the configured fuel later without breaking (or
// silently rewriting) the devices already on their dashboard.
//
// Features, both read-only:
//   - price      : the price at the pump, EUR/litre, kept in history so Gladys
//                  draws the price curve;
//   - updated_at : when the station last declared that price (the feed
//                  refreshes every ~10 min, a given station much less often).
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { fuelLabel } from '../fuels.js';

export const DEVICE_TYPE = 'fuel-station';

const logger = createLogger({ name: DEVICE_TYPE });

export const FEATURE = {
  PRICE: 'price',
  UPDATED_AT: 'updated_at',
};

// No fuel on the French market has ever been close to this, but a feature needs
// a range and an absurd one would ruin the dashboard scale.
const MAX_PRICE_PER_LITRE = 10;

/**
 * Platform id of a (station, fuel) pair — the stable part of the external id.
 * Country code first so two countries never collide on a numeric station id.
 * @param {{ country: string, stationId: string, fuel: string }} target
 */
export function platformId({ country, stationId, fuel }) {
  return `${country}-${stationId}-${fuel}`;
}

/**
 * @param {object} gladys SDK instance
 * @param {{ country: string, stationId: string, fuel: string }} target
 */
export function deviceExternalId(gladys, target) {
  return gladys.externalIds(DEVICE_TYPE, platformId(target)).device;
}

/**
 * Read back the (country, station, fuel) triplet from a device external id.
 *
 * The id looks like `ext:<selector>:fuel-station:FR-35000005-gazole`. We cut
 * after the device type marker rather than splitting on ':' so a selector
 * containing a colon cannot break the parsing.
 *
 * @param {string} externalId
 * @returns {{ country: string, stationId: string, fuel: string }|null}
 */
export function parseDeviceExternalId(externalId) {
  const marker = `${DEVICE_TYPE}:`;
  const index = String(externalId ?? '').lastIndexOf(marker);
  if (index === -1) {
    return null;
  }
  const match = /^([A-Z]{2})-(.+)-([a-z0-9]+)$/.exec(externalId.slice(index + marker.length));
  if (!match) {
    return null;
  }
  const [, country, stationId, fuel] = match;
  return { country, stationId, fuel };
}

/**
 * Discovery payload of one (station, fuel) pair.
 *
 * No `poll_frequency` here, on purpose. Gladys can drive the polling itself,
 * but its `poll_frequency` is an ENUM of millisecond values capped at ONE
 * MINUTE (1s, 2s, 10s, 15s, 30s, 60s) — sized for a plug or a lamp. A national
 * fuel price feed refreshed every ~10 minutes, and a user asking for "once an
 * hour", simply do not fit in it: any other value makes Gladys reject the WHOLE
 * discovery payload (`poll_frequency: invalid poll frequency`), which is why
 * the Discovery tab used to stay empty. The refresh interval therefore lives in
 * the integration's own loop (src/refresh.js), which honours the seconds the
 * user configured.
 *
 * @param {object} gladys SDK instance
 * @param {{ station: object, country: string, fuel: string }} context
 */
export function buildDevice(gladys, { station, country, fuel }) {
  const ids = gladys.externalIds(DEVICE_TYPE, platformId({ country, stationId: station.id, fuel }));

  return {
    name: `${station.name} - ${fuelLabel(fuel, 'en')}`,
    external_id: ids.device,
    // Params are upserted on every re-publish, so the address and the distance
    // stay up to date even on a device the user created weeks ago.
    params: buildParams(station, country, fuel),
    features: [
      {
        name: `${fuelLabel(fuel, 'en')} price`,
        external_id: ids.feature(FEATURE.PRICE),
        category: DEVICE_FEATURE_CATEGORIES.CURRENCY,
        type: DEVICE_FEATURE_TYPES.CURRENCY.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.EURO,
        min: 0,
        max: MAX_PRICE_PER_LITRE,
        read_only: true,
        has_feedback: false,
        keep_history: true, // the whole point: chart the price over time
      },
      {
        name: 'Last price update',
        external_id: ids.feature(FEATURE.UPDATED_AT),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        // `min` and `max` are NOT NULL in Gladys for EVERY feature, including
        // the ones that hold text and have no range: omitting them made the
        // whole device creation fail with "HTTP 422 - min cannot be null" the
        // moment the user pressed "Add to Gladys". A text feature ignores them.
        min: 0,
        max: 0,
        read_only: true,
        has_feedback: false,
        keep_history: false, // a timestamp curve would say nothing
      },
    ],
  };
}

/**
 * Device params: everything a user needs to recognise the station, and
 * everything a scene may want to read. Values are strings by contract.
 */
function buildParams(station, country, fuel) {
  const params = [
    { name: 'country', value: country },
    { name: 'station_id', value: String(station.id) },
    { name: 'fuel', value: fuel },
    { name: 'brand', value: station.brand || '' },
    {
      name: 'address',
      value: [station.address, station.postalCode, station.city].join(' ').trim(),
    },
  ];
  if (Number.isFinite(station.latitude) && Number.isFinite(station.longitude)) {
    params.push(
      { name: 'latitude', value: String(station.latitude) },
      { name: 'longitude', value: String(station.longitude) },
    );
  }
  if (Number.isFinite(station.distanceKm)) {
    params.push({ name: 'distance_km', value: station.distanceKm.toFixed(1) });
  }
  return params;
}

/**
 * Read the current price of a device and publish it.
 *
 * @param {object} gladys SDK instance
 * @param {{ device: object, store: object }} context
 * @returns {Promise<{ price: number|null }>}
 */
export async function pollDevice(gladys, { device, store }) {
  const target = parseDeviceExternalId(device.external_id);
  if (!target) {
    throw new Error(`Unrecognized fuel station device: ${device.external_id}`);
  }

  const station = await store.getStation(target.country, target.stationId);
  if (!station) {
    throw new Error(`Station ${target.stationId} is not in the ${target.country} feed anymore`);
  }

  const price = station.prices[target.fuel] ?? null;
  if (price === null) {
    // Not an error: a station stops selling a fuel, or has not declared a price
    // yet. Publishing nothing keeps the last known value on the dashboard
    // instead of drawing a hole in the chart.
    logger.info(`${station.name}: no ${target.fuel} price published, keeping the previous one`);
    return { price: null };
  }

  const ids = gladys.externalIds(DEVICE_TYPE, platformId(target));
  await gladys.publishState(ids.feature(FEATURE.PRICE), price);

  const updatedAt = station.updatedAt[target.fuel];
  if (updatedAt) {
    await gladys.publishState(ids.feature(FEATURE.UPDATED_AT), { text: updatedAt });
  }

  logger.info(`${station.name}: ${target.fuel} at ${price.toFixed(3)} EUR/L`);
  return { price };
}

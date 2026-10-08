// -----------------------------------------------------------------------------
// Device registry.
//
// Unlike a template with a fixed catalog, this integration has NO device known
// in advance: the list depends on the postal code the user typed. Discovery
// therefore works like this:
//
//   1. the provider of the configured country returns the stations around the
//      postal code (src/countries/);
//   2. we turn every (station, fuel) pair the station actually sells into a
//      discovered device;
//   3. Gladys shows them in the DISCOVERY tab, and the user adds the ones they
//      want — one, several, or all of them.
//
// Devices the user already created are ALWAYS re-published, even when they fall
// outside the current search (the user moved the postal code, or the station is
// temporarily absent from the feed). Otherwise a configuration change would
// quietly drop a device that keeps working perfectly.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { sellsFuel } from '../availability.js';
import { getProvider } from '../countries/index.js';
import { fuelLabel } from '../fuels.js';
import { buildDevice, parseDeviceExternalId } from './fuelStation.js';
import { buildIntegrationDevice } from './integration.js';

const logger = createLogger({ name: 'devices' });

export {
  DEVICE_TYPE,
  FEATURE,
  buildDevice,
  deviceExternalId,
  parseDeviceExternalId,
  platformId,
  pollDevice,
  readDeviceStates,
} from './fuelStation.js';

export {
  DEVICE_TYPE as INTEGRATION_DEVICE_TYPE,
  FEATURE as INTEGRATION_FEATURE,
  buildIntegrationDevice,
  integrationExternalId,
  integrationStates,
  isIntegrationDevice,
  publishIntegrationState,
} from './integration.js';

/**
 * Turn a list of stations into the discovery payload.
 *
 * A (station, fuel) pair is published only when the station SELLS that fuel:
 * the dataset covers every pump in the country, and offering "LPG at a station
 * that does not sell LPG" would fill the discovery tab with devices that can
 * never publish a state.
 *
 * Selling it does not mean having a price today. A station declaring a
 * temporary rupture is out of stock, not out of business: its price comes back
 * in a few hours, so the device is offered right away rather than making the
 * user come back to the Discovery tab once the tanker has passed.
 *
 * @param {object} gladys SDK instance
 * @param {object} config normalized configuration
 * @param {Array<object>} stations
 */
export function buildDiscoveredDevices(gladys, config, stations) {
  const country = getProvider(config.country).code;
  const devices = [];
  for (const station of stations) {
    for (const fuel of config.fuel_type) {
      if (!sellsFuel(station, fuel)) {
        continue;
      }
      devices.push(buildDevice(gladys, { station, country, fuel }));
    }
  }
  return devices;
}

/**
 * Read the (country, station, fuel) targets carried by the devices Gladys
 * holds, ignoring anything that is not one of ours.
 * @param {Array<{ external_id: string }>} devices
 */
export function parseTargets(devices = []) {
  return devices
    .map((device) => {
      const target = parseDeviceExternalId(device.external_id);
      return target ? { ...target, device } : null;
    })
    .filter(Boolean);
}

/** The params that identify a device, and only those: see `buildCreatedDevices`. */
const IDENTITY_PARAMS = new Set(['country', 'station_id', 'fuel']);

/**
 * Up to 2.2.0 a station carried a `distance_km` param, measured from the Gladys
 * house when the search is centred on it — enough to locate the house once three
 * stations are known. The core upserts the params it receives and NEVER deletes
 * one (`upsertDeviceParams`; its `removeDeviceParams` is reserved to the
 * `GLADYS_TRANSPORT*` params), so leaving the param out kept the old value
 * forever. Overwriting it with an empty string is the only way to wipe it, and
 * only a device that still holds a value gets one: a device created since never
 * sees the param at all.
 */
const BLANK_DISTANCE = Object.freeze({ name: 'distance_km', value: '' });

/**
 * @param {{ params?: Array<{ name: string, value: string }> }} device
 * @returns {boolean} true when Gladys still stores a non-empty distance for it
 */
function hasStoredDistance(device) {
  return (device.params ?? []).some((p) => p?.name === 'distance_km' && p.value !== '');
}

/**
 * Rebuild the discovery payload of the devices the user already added, from the
 * freshest station data we have. Nothing is fetched here: `store.peek` returns
 * the cached station or null, and a device we know nothing about is rebuilt
 * from the name Gladys already stores.
 *
 * Such a device carries its IDENTITY params only. The core upserts the params
 * of a created device on every re-publish, so sending the empty brand, address
 * and coordinates of a station we simply have not read yet used to overwrite
 * the real ones: every restart erased them on a device outside the search area,
 * until the next refresh pass happened to re-publish nothing (a refresh
 * publishes states, never params). A param we do not send is a param the core
 * leaves alone.
 *
 * @param {object} gladys SDK instance
 * @param {object} config normalized configuration
 * @param {Array<{ external_id: string, name?: string }>} createdDevices
 * @param {object} store station store
 */
export function buildCreatedDevices(gladys, config, createdDevices, store) {
  return parseTargets(createdDevices).map(({ country, stationId, fuel, device }) => {
    const station = store.peek(country, stationId) ?? {
      id: stationId,
      // Keep the name the user already sees rather than inventing a new one.
      name: device.name ?? `Station ${stationId}`,
      brand: '',
      address: '',
      city: '',
      postalCode: '',
      latitude: null,
      longitude: null,
      prices: {},
      updatedAt: {},
      availability: {},
      outOfStockSince: {},
    };
    const payload = buildDevice(gladys, { station, country, fuel });
    const known = store.peek(country, stationId) !== null;
    const params = known
      ? payload.params
      : payload.params.filter((p) => IDENTITY_PARAMS.has(p.name));
    return {
      ...payload,
      // A created device keeps the name the user gave it; do not fight over it.
      name: device.name ?? payload.name,
      params: hasStoredDistance(device) ? [...params, BLANK_DISTANCE] : params,
    };
  });
}

/**
 * Read the created stations the search did not bring back, in one batch per
 * country, so their params are re-published with real values rather than left
 * out. On `connected` the discovery runs before the first refresh pass, and a
 * station outside the search area (the user moved the postal code) is in no
 * cache yet. That batch is the one the refresh pass would send anyway, and the
 * pass that follows is then served from the store cache.
 *
 * Best effort: a failure only means those devices keep their identity params
 * this time (see `buildCreatedDevices`), never a failed discovery.
 *
 * @param {object} store station store
 * @param {Array<{ external_id: string }>} createdDevices
 */
async function readCreatedStations(store, createdDevices) {
  const countries = new Set();
  for (const { country, stationId } of parseTargets(createdDevices)) {
    if (store.peek(country, stationId) === null) {
      store.track(country, stationId);
      countries.add(country);
    }
  }
  for (const country of countries) {
    try {
      await store.refreshTracked(country);
    } catch (err) {
      logger.warn(`Created stations of ${country} not read before discovery: ${err.message}`);
    }
  }
}

/**
 * Full discovery pass: search, merge with the devices already created, publish.
 *
 * @param {object} gladys SDK instance
 * @param {{ config: object, store: object, createdDevices?: Array<object> }} context
 * @returns {Promise<{ found: number, published: number }>}
 */
export async function publishDiscovery(gladys, { config, store, createdDevices = [] }) {
  const stations = await store.search(config);
  await readCreatedStations(store, createdDevices);
  const discovered = buildDiscoveredDevices(gladys, config, stations);
  const existing = buildCreatedDevices(gladys, config, createdDevices, store);

  // The integration device is always offered, even when the search comes back
  // empty: "when was the feed last read" is exactly what a user with no station
  // in their Discovery tab wants to know. `parseTargets` ignores it (it is no
  // station), so its name is preserved here rather than in buildCreatedDevices.
  const integration = buildIntegrationDevice(gladys);
  const createdIntegration = createdDevices.find((d) => d.external_id === integration.external_id);
  if (createdIntegration?.name) {
    integration.name = createdIntegration.name;
  }

  // Merge, created devices last so their payload (and their user-chosen name)
  // wins over the freshly discovered one for the same external_id.
  const byExternalId = new Map();
  for (const device of [...discovered, ...existing, integration]) {
    byExternalId.set(device.external_id, device);
  }
  const devices = [...byExternalId.values()];

  logger.info(
    `Discovery: ${stations.length} station(s) around ${config.postal_code}, ` +
      `${devices.length} device(s) published for ${config.fuel_type.map((f) => fuelLabel(f)).join(', ')}`,
  );
  await gladys.publishDiscoveredDevices(devices);
  return { found: stations.length, published: devices.length };
}

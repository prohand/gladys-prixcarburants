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
} from './fuelStation.js';

export {
  DEVICE_TYPE as INTEGRATION_DEVICE_TYPE,
  FEATURE as INTEGRATION_FEATURE,
  buildIntegrationDevice,
  integrationExternalId,
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

/**
 * Rebuild the discovery payload of the devices the user already added, from the
 * freshest station data we have. Nothing is fetched here: `store.peek` returns
 * the cached station or null, and a device we know nothing about is rebuilt
 * from the name Gladys already stores.
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
    // A created device keeps the name the user gave it; do not fight over it.
    return { ...payload, name: device.name ?? payload.name };
  });
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

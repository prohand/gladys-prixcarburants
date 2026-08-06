// -----------------------------------------------------------------------------
// Device registry.
//
// Unlike a template with a fixed catalog, this integration has NO device known
// in advance: the list depends on the postal code the user typed. Discovery
// therefore works like this:
//
//   1. the provider of the configured country returns the stations around the
//      postal code (src/countries/);
//   2. we turn every (station, fuel) pair that actually has a price into a
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
import { getProvider } from '../countries/index.js';
import { fuelLabel } from '../fuels.js';
import { buildDevice, parseDeviceExternalId } from './fuelStation.js';

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

/**
 * Turn a list of stations into the discovery payload.
 *
 * A (station, fuel) pair is published only when the station currently has a
 * price for that fuel: the dataset covers every pump in the country, and
 * offering "LPG at a station that does not sell LPG" would fill the discovery
 * tab with devices that can never publish a state.
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
      if (station.prices?.[fuel] === null || station.prices?.[fuel] === undefined) {
        continue;
      }
      devices.push(buildDevice(gladys, { station, country, fuel, config }));
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
    };
    const payload = buildDevice(gladys, { station, country, fuel, config });
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

  // Merge, created devices last so their payload (and their user-chosen name)
  // wins over the freshly discovered one for the same external_id.
  const byExternalId = new Map();
  for (const device of [...discovered, ...existing]) {
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

// -----------------------------------------------------------------------------
// Minimal in-memory stand-ins used by the unit tests.
//
// `createFakeGladys` reproduces the only SDK surface the code relies on, and
// `createFakeProvider` replaces a country provider (and therefore the HTTP
// calls) with a scripted list of stations that also counts its own calls — that
// is how the batching of the station store is asserted.
// -----------------------------------------------------------------------------

export function createFakeGladys({ devices = [] } = {}) {
  const published = [];
  const discovered = [];
  const connectionStatuses = [];

  // Built as a named object so `getDevices` reads the CURRENT `devices`
  // property: a test may assign it after construction, once it has used
  // `externalIds` to forge the device ids.
  const fake = {
    published,
    discovered,
    connectionStatuses,
    devices,

    externalIds(type, platformId) {
      const device = `ext:prix-carburants:${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async getDevices() {
      return fake.devices;
    },

    async publishDiscoveredDevices(list) {
      discovered.push(list);
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const s of states) {
        published.push({ featureExternalId: s.device_feature_external_id, state: s.state });
      }
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },
  };

  return fake;
}

/**
 * A country provider whose answers are scripted, and which records how many
 * times it was called.
 * @param {{ code?: string, stations?: Array<object> }} options
 */
export function createFakeProvider({ code = 'FR', stations = [] } = {}) {
  const byId = new Map(stations.map((station) => [station.id, station]));
  const calls = { search: 0, fetchByIds: [] };

  return {
    code,
    label: { en: 'Fake', fr: 'Fake' },
    postalCodeExample: '35000',
    fuels: ['gazole', 'sp95'],
    attribution: { en: 'Fake', fr: 'Fake' },
    calls,

    isValidPostalCode: (postalCode) => /^\d{5}$/.test(String(postalCode)),

    async searchStations() {
      calls.search += 1;
      return stations;
    },

    async fetchStationsByIds(ids) {
      calls.fetchByIds.push([...ids]);
      return ids.map((id) => byId.get(id)).filter(Boolean);
    },
  };
}

/**
 * A station in the internal shape the providers produce.
 * @param {Partial<{ id: string, name: string, prices: object }>} overrides
 */
export function createStation(overrides = {}) {
  return {
    id: '35000001',
    name: 'TotalEnergies - Rennes',
    brand: 'TotalEnergies',
    address: '1 rue de Nantes',
    city: 'Rennes',
    postalCode: '35000',
    latitude: 48.1113,
    longitude: -1.6845,
    distanceKm: 1.2,
    inPostalCode: true,
    prices: { gazole: 1.699, sp95: null, sp98: 1.879, e10: 1.729, e85: null, gplc: null },
    updatedAt: { gazole: '2026-08-06T07:12:00+02:00', sp98: '2026-08-06T07:12:00+02:00' },
    ...overrides,
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import {
  FEATURE,
  buildCreatedDevices,
  buildDiscoveredDevices,
  deviceExternalId,
  parseDeviceExternalId,
  parseTargets,
  pollDevice,
  publishDiscovery,
} from '../src/devices/index.js';
import { createStationStore } from '../src/stationStore.js';
import { createFakeGladys, createFakeProvider, createStation } from './helpers/fakeGladys.js';

const config = normalizeConfig({ postal_code: '35000', fuel_type: ['gazole', 'sp98'] });

function storeWith(stations) {
  const provider = createFakeProvider({ stations });
  const store = createStationStore({ resolveProvider: () => provider });
  return { store, provider };
}

test('external ids round-trip through the (country, station, fuel) triplet', () => {
  const gladys = createFakeGladys();
  const target = { country: 'FR', stationId: '35000001', fuel: 'gazole' };
  assert.deepEqual(parseDeviceExternalId(deviceExternalId(gladys, target)), target);
});

test('parseDeviceExternalId ignores devices from another integration', () => {
  assert.equal(parseDeviceExternalId('ext:zwave:node:12'), null);
  assert.equal(parseDeviceExternalId(undefined), null);
});

test('discovery publishes one device per station AND per selected fuel', () => {
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(gladys, config, [createStation()]);

  assert.equal(devices.length, 2, 'gazole and sp98 have a price, sp95 does not');
  assert.deepEqual(
    devices.map((d) => d.name),
    ['TotalEnergies - Rennes - Diesel', 'TotalEnergies - Rennes - SP98'],
  );
});

test('discovery skips a fuel the station does not sell', () => {
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(gladys, normalizeConfig({ fuel_type: ['e85'] }), [
    createStation(),
  ]);
  assert.deepEqual(devices, [], 'no E85 price means no E85 device to add');
});

test('a discovered device carries a price feature and an update feature', () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, normalizeConfig({ fuel_type: ['gazole'] }), [
    createStation(),
  ]);

  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').pop()),
    [FEATURE.PRICE, FEATURE.UPDATED_AT],
  );
  const [price] = device.features;
  assert.equal(price.unit, 'euro');
  assert.equal(price.read_only, true);
  assert.equal(price.keep_history, true);

  const params = Object.fromEntries(device.params.map((p) => [p.name, p.value]));
  assert.equal(params.station_id, '35000001');
  assert.equal(params.fuel, 'gazole');
  assert.equal(params.address, '1 rue de Nantes 35000 Rennes');
  assert.equal(params.distance_km, '1.2');
});

test('every feature declares a min and a max', () => {
  // `min` and `max` are NOT NULL in Gladys for every feature, text ones
  // included: without them, pressing "Add to Gladys" answered HTTP 422 and the
  // station was never created.
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, config, [createStation()]);

  for (const feature of device.features) {
    assert.equal(typeof feature.min, 'number', `${feature.name} must declare a min`);
    assert.equal(typeof feature.max, 'number', `${feature.name} must declare a max`);
  }
});

test('a discovered device declares no poll_frequency', () => {
  // Gladys only accepts the millisecond enum of DEVICE_POLL_FREQUENCIES, capped
  // at one minute: publishing the configured interval (seconds, up to 24 h)
  // makes it reject the WHOLE payload and the Discovery tab stays empty.
  // Refreshing is src/refresh.js's job.
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(gladys, config, [createStation()]);
  const created = buildCreatedDevices(gladys, config, [{ external_id: devices[0].external_id }], {
    peek: () => null,
  });

  for (const device of [...devices, ...created]) {
    assert.ok(!('poll_frequency' in device), `${device.name} must not declare a poll_frequency`);
  }
});

test('polling publishes the price and the update date of the right fuel', async () => {
  const gladys = createFakeGladys();
  const { store } = storeWith([createStation()]);
  const external_id = deviceExternalId(gladys, {
    country: 'FR',
    stationId: '35000001',
    fuel: 'gazole',
  });

  const { price } = await pollDevice(gladys, { device: { external_id }, store });

  assert.equal(price, 1.699);
  assert.deepEqual(gladys.published, [
    { featureExternalId: `${external_id}:price`, state: 1.699 },
    {
      featureExternalId: `${external_id}:updated_at`,
      // Readable on a dashboard tile, and still the wall-clock time declared by
      // the station — not the container's timezone.
      state: { text: '06/08/2026 à 07:12' },
    },
  ]);
});

test('polling a fuel without a price keeps the previous state instead of publishing', async () => {
  const gladys = createFakeGladys();
  const { store } = storeWith([createStation()]);
  const external_id = deviceExternalId(gladys, {
    country: 'FR',
    stationId: '35000001',
    fuel: 'sp95',
  });

  const { price } = await pollDevice(gladys, { device: { external_id }, store });

  assert.equal(price, null);
  assert.deepEqual(gladys.published, []);
});

test('discovery offers a pump the station is temporarily out of', () => {
  const gladys = createFakeGladys();
  // Out of stock is not "not sold": the price comes back with the tanker, and
  // the user must be able to add the device before it does.
  const station = createStation({
    prices: { gazole: 1.699, sp98: null },
    availability: { gazole: 'available', sp98: 'out_of_stock' },
    outOfStockSince: { sp98: '2026-09-18 08:09:56' },
  });

  const devices = buildDiscoveredDevices(gladys, config, [station]);
  assert.deepEqual(
    devices.map((d) => d.name),
    ['TotalEnergies - Rennes - Diesel', 'TotalEnergies - Rennes - SP98'],
  );
});

test('polling a fuel out of stock says so instead of freezing silently', async () => {
  const gladys = createFakeGladys();
  const { store } = storeWith([
    createStation({
      prices: { sp98: null },
      availability: { sp98: 'out_of_stock' },
      outOfStockSince: { sp98: '2026-09-18 08:09:56' },
    }),
  ]);
  const external_id = deviceExternalId(gladys, {
    country: 'FR',
    stationId: '35000001',
    fuel: 'sp98',
  });

  const { price } = await pollDevice(gladys, { device: { external_id }, store });

  assert.equal(price, null, 'no price is published: the last known one stays on the chart');
  assert.deepEqual(gladys.published, [
    {
      featureExternalId: `${external_id}:updated_at`,
      state: { text: 'En rupture depuis le 18/09/2026 à 08:09' },
    },
  ]);
});

test('polling a station that vanished from the feed fails loudly', async () => {
  const gladys = createFakeGladys();
  const { store } = storeWith([]);
  const external_id = deviceExternalId(gladys, { country: 'FR', stationId: '404', fuel: 'gazole' });

  await assert.rejects(
    () => pollDevice(gladys, { device: { external_id }, store }),
    /not in the FR feed anymore/,
  );
});

test('devices already created stay published even outside the current search', async () => {
  const gladys = createFakeGladys();
  const { store } = storeWith([]); // the new postal code returns nothing
  const external_id = deviceExternalId(gladys, {
    country: 'FR',
    stationId: '35000001',
    fuel: 'gazole',
  });
  const createdDevices = [{ external_id, name: 'Station du bureau' }];

  const result = await publishDiscovery(gladys, { config, store, createdDevices });

  assert.equal(result.found, 0);
  assert.equal(result.published, 2, 'the created station, plus the integration device');
  const [published] = gladys.discovered;
  assert.equal(published[0].external_id, external_id);
  assert.equal(published[0].name, 'Station du bureau', 'the name chosen by the user is kept');
});

test('discovery does not duplicate a station the user already added', async () => {
  const gladys = createFakeGladys();
  const { store } = storeWith([createStation()]);
  const external_id = deviceExternalId(gladys, {
    country: 'FR',
    stationId: '35000001',
    fuel: 'gazole',
  });

  await publishDiscovery(gladys, { config, store, createdDevices: [{ external_id }] });

  const [published] = gladys.discovered;
  assert.equal(published.length, 3, 'gazole (already added) + sp98 + the integration device');
  assert.equal(new Set(published.map((d) => d.external_id)).size, 3);
});

test('parseTargets keeps only our own devices', () => {
  const gladys = createFakeGladys();
  const external_id = deviceExternalId(gladys, {
    country: 'FR',
    stationId: '35000001',
    fuel: 'gazole',
  });

  const targets = parseTargets([{ external_id }, { external_id: 'ext:mqtt:sensor:1' }]);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].stationId, '35000001');
});

test('a created device we know nothing about still gets a valid payload', () => {
  const gladys = createFakeGladys();
  const { store } = storeWith([]);
  const external_id = deviceExternalId(gladys, { country: 'FR', stationId: '99', fuel: 'gazole' });

  const [device] = buildCreatedDevices(gladys, config, [{ external_id, name: 'Chez moi' }], store);

  assert.equal(device.external_id, external_id);
  assert.equal(device.name, 'Chez moi');
  assert.equal(device.features.length, 2);
});

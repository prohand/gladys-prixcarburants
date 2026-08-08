// -----------------------------------------------------------------------------
// The integration device answers "when did we last read the feed?" — the one
// piece of information no station device can give, since the date a station
// carries is the date IT declared its price.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import {
  INTEGRATION_FEATURE,
  buildIntegrationDevice,
  deviceExternalId,
  integrationExternalId,
  isIntegrationDevice,
  parseTargets,
  publishDiscovery,
  publishIntegrationState,
} from '../src/devices/index.js';
import { refreshAllDevices } from '../src/refresh.js';
import { createStationStore } from '../src/stationStore.js';
import { createFakeGladys, createFakeProvider, createStation } from './helpers/fakeGladys.js';

const config = normalizeConfig({ postal_code: '35000', fuel_type: ['gazole'] });

function storeWith(stations, now) {
  const provider = createFakeProvider({ stations });
  return { provider, store: createStationStore({ resolveProvider: () => provider, now }) };
}

test('the integration device is a single device, independent of the configuration', () => {
  const gladys = createFakeGladys();
  const device = buildIntegrationDevice(gladys);

  assert.equal(device.external_id, integrationExternalId(gladys));
  assert.equal(device.features.length, 1);
  assert.equal(device.features[0].external_id.split(':').pop(), INTEGRATION_FEATURE.LAST_REFRESH);
  // Same NOT NULL constraint as every other feature, text or not.
  assert.equal(typeof device.features[0].min, 'number');
  assert.equal(typeof device.features[0].max, 'number');
  assert.ok(!('poll_frequency' in device), 'the refresh loop owns the schedule');
});

test('the integration device is named in French', () => {
  const gladys = createFakeGladys();
  const device = buildIntegrationDevice(gladys);

  assert.equal(device.name, 'Prix carburants - Mise à jour des données');
  assert.equal(device.features[0].name, 'Dernière lecture des données');
});

test('the integration device is not mistaken for a station', () => {
  const gladys = createFakeGladys();
  const externalId = integrationExternalId(gladys);

  assert.equal(isIntegrationDevice(gladys, externalId), true);
  assert.equal(isIntegrationDevice(gladys, 'ext:prix-carburants:fuel-station:FR-1-gazole'), false);
  // parseTargets drives the refresh loop and the tracked station set: letting
  // the integration device through would make it look for station "status".
  assert.deepEqual(parseTargets([{ external_id: externalId }]), []);
});

test('discovery always offers the integration device, even with no station found', async () => {
  const gladys = createFakeGladys();
  const { store } = storeWith([]);

  await publishDiscovery(gladys, { config, store, createdDevices: [] });

  const [published] = gladys.discovered;
  assert.deepEqual(
    published.map((d) => d.external_id),
    [integrationExternalId(gladys)],
  );
});

test('discovery keeps the name the user gave the integration device', async () => {
  const gladys = createFakeGladys();
  const { store } = storeWith([]);
  const external_id = integrationExternalId(gladys);

  await publishDiscovery(gladys, {
    config,
    store,
    createdDevices: [{ external_id, name: 'Fraîcheur des prix' }],
  });

  const [published] = gladys.discovered;
  assert.equal(published.length, 1, 'the created device is not duplicated by the discovered one');
  assert.equal(published[0].name, 'Fraîcheur des prix');
});

test('a refresh pass publishes the moment the feed was read', async () => {
  const gladys = createFakeGladys();
  const { store } = storeWith([createStation({ id: '1' })], () =>
    new Date(2026, 7, 8, 21, 0).getTime(),
  );
  gladys.devices = [
    { external_id: deviceExternalId(gladys, { country: 'FR', stationId: '1', fuel: 'gazole' }) },
    { external_id: integrationExternalId(gladys) },
  ];

  await refreshAllDevices(gladys, { config, store });

  assert.deepEqual(gladys.published.at(-1), {
    featureExternalId: `${integrationExternalId(gladys)}:${INTEGRATION_FEATURE.LAST_REFRESH}`,
    // Published last, so it dates the read this very pass just did.
    state: { text: '08/08/2026 à 21:00' },
  });
});

test('the status is published even when the user added no station at all', async () => {
  const gladys = createFakeGladys();
  const { store } = storeWith([], () => new Date(2026, 7, 8, 21, 0).getTime());
  gladys.devices = [{ external_id: integrationExternalId(gladys) }];
  await store.search(config); // the Discovery tab already read the feed once

  await refreshAllDevices(gladys, { config, store });

  assert.deepEqual(gladys.published, [
    {
      featureExternalId: `${integrationExternalId(gladys)}:${INTEGRATION_FEATURE.LAST_REFRESH}`,
      state: { text: '08/08/2026 à 21:00' },
    },
  ]);
});

test('a user who did not add the integration device gets no state published', async () => {
  const gladys = createFakeGladys();
  const { store } = storeWith([createStation()]);
  await store.search(config);

  const published = await publishIntegrationState(gladys, { store, devices: [] });

  assert.equal(published, null);
  assert.deepEqual(gladys.published, []);
});

test('nothing is published before the first successful read', async () => {
  const gladys = createFakeGladys();
  const { store } = storeWith([]);
  const devices = [{ external_id: integrationExternalId(gladys) }];

  // A container that just started and has never reached the API must not claim
  // a read time — the empty tile IS the information.
  const published = await publishIntegrationState(gladys, { store, devices });

  assert.equal(published, null);
  assert.deepEqual(gladys.published, []);
});

test('a failed read leaves the date ageing instead of refreshing it', async () => {
  const gladys = createFakeGladys();
  let clock = new Date(2026, 7, 8, 21, 0).getTime();
  const provider = createFakeProvider({ stations: [createStation({ id: '1' })] });
  const store = createStationStore({ resolveProvider: () => provider, now: () => clock });

  await store.search(config); // one successful read, at 21:00
  clock = new Date(2026, 7, 8, 22, 0).getTime();
  provider.fetchStationsByIds = async () => {
    throw new Error('open data API is down');
  };
  gladys.devices = [{ external_id: integrationExternalId(gladys) }];

  await refreshAllDevices(gladys, { config, store });

  assert.deepEqual(gladys.published, [
    {
      featureExternalId: `${integrationExternalId(gladys)}:${INTEGRATION_FEATURE.LAST_REFRESH}`,
      // Still 21:00: the dashboard shows an ageing date, which is the signal.
      state: { text: '08/08/2026 à 21:00' },
    },
  ]);
});

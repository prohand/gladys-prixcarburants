import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { refreshPrices, searchStations } from '../src/actions.js';
import { deviceExternalId } from '../src/devices/index.js';
import { createStationStore } from '../src/stationStore.js';
import { createFakeGladys, createFakeProvider, createStation } from './helpers/fakeGladys.js';

const config = normalizeConfig({ postal_code: '35000', fuel_type: ['gazole'] });

function storeWith(stations) {
  const provider = createFakeProvider({ stations });
  return { provider, store: createStationStore({ resolveProvider: () => provider }) };
}

test('search_stations asks for a postal code when there is none', async () => {
  const { store } = storeWith([]);
  const message = await searchStations(createFakeGladys(), { config: normalizeConfig(), store });
  assert.match(message.fr, /code postal/);
});

test('search_stations rejects a malformed postal code without calling the provider', async () => {
  const { provider, store } = storeWith([createStation()]);
  const message = await searchStations(createFakeGladys(), {
    config: normalizeConfig({ postal_code: '350' }),
    store,
  });
  assert.match(message.en, /not a valid France postal code/);
  assert.equal(provider.calls.search, 0);
});

test('search_stations lists the stations it found with their price', async () => {
  const { store } = storeWith([createStation()]);
  const message = await searchStations(createFakeGladys(), { config, store });
  assert.match(message.en, /1 station\(s\) around 35000/);
  assert.match(message.en, /TotalEnergies - Rennes \(1\.2 km\)/);
  assert.match(message.en, /Diesel: 1\.699 EUR\/L/);
});

test('search_stations suggests a wider radius when nothing is found', async () => {
  const { store } = storeWith([]);
  const message = await searchStations(createFakeGladys(), { config, store });
  assert.match(message.en, /No station found/);
});

test('refresh_prices tells the user to add a station first', async () => {
  const { store } = storeWith([createStation()]);
  const message = await refreshPrices(createFakeGladys({ devices: [] }), { config, store });
  assert.match(message.en, /No station added yet/);
});

test('refresh_prices republishes every added station', async () => {
  const { store } = storeWith([createStation({ id: '1' }), createStation({ id: '2' })]);
  const gladys = createFakeGladys();
  gladys.devices = ['1', '2'].map((stationId) => ({
    external_id: deviceExternalId(gladys, { country: 'FR', stationId, fuel: 'gazole' }),
  }));

  const message = await refreshPrices(gladys, { config, store });

  assert.match(message.en, /^2\/2 price\(s\) refreshed\.$/);
  assert.equal(gladys.published.filter((p) => p.featureExternalId.endsWith(':price')).length, 2);
});

test('refresh_prices reports the stations it could not read', async () => {
  const { store } = storeWith([createStation({ id: '1' })]);
  const gladys = createFakeGladys();
  gladys.devices = ['1', 'gone'].map((stationId) => ({
    external_id: deviceExternalId(gladys, { country: 'FR', stationId, fuel: 'gazole' }),
  }));

  const message = await refreshPrices(gladys, { config, store });

  assert.match(message.en, /^1\/2 price\(s\) refreshed \(1 failed\)\.$/);
});

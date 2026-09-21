// -----------------------------------------------------------------------------
// Scene actions (GladysAssistant/Gladys#3110, shipped in Gladys 5.1).
//
// Two things are tested here: what the handlers answer, and the fact that
// every declared key is actually registered on `onSceneAction` with a callback
// that reads the CURRENT configuration. The core acks for us, so what is left
// on our side is the registration and the outputs.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { createStationStore } from '../src/stationStore.js';
import { deviceExternalId } from '../src/devices/index.js';
import {
  SCENE_ACTIONS,
  SCENE_ACTION_CONTRACT,
  cheapestStation,
  priceReport,
  refreshPrices,
  registerSceneActions,
} from '../src/sceneActions.js';
import { createFakeGladys, createFakeProvider, createStation } from './helpers/fakeGladys.js';

const config = normalizeConfig({ postal_code: '35000', fuel_type: ['gazole'] });

/** A Gladys holding one device per station, and a store serving those stations. */
function scenario(stations, { fuel = 'gazole' } = {}) {
  const provider = createFakeProvider({ stations });
  const store = createStationStore({ resolveProvider: () => provider });
  const gladys = createFakeGladys();
  gladys.devices = stations.map((station) => ({
    external_id: deviceExternalId(gladys, { country: 'FR', stationId: station.id, fuel }),
  }));
  return { gladys, store, provider, context: { config, store } };
}

/** A station selling `gazole` at the given price. */
function station(id, price, overrides = {}) {
  return createStation({
    id,
    name: `Station ${id}`,
    prices: { gazole: price, sp98: null },
    ...overrides,
  });
}

test('refresh_prices reports what the pass actually did', async () => {
  const { gladys, context } = scenario([station('1', 1.699), station('2', 1.729)]);

  const outputs = await refreshPrices(gladys, {}, context);

  assert.deepEqual(outputs, { total: 2, updated: 2, failed: 0 });
});

test('cheapest_station picks the cheapest of the followed stations', async () => {
  const { gladys, context } = scenario([
    station('1', 1.729),
    station('2', 1.659, { city: 'Cesson', distanceKm: 3.42 }),
    station('3', 1.699),
  ]);

  const outputs = await cheapestStation(gladys, { fuel: 'gazole' }, context);

  assert.equal(outputs.found, true);
  assert.equal(outputs.station_name, 'Station 2');
  assert.equal(outputs.price, 1.659);
  assert.equal(outputs.city, 'Cesson');
  assert.equal(outputs.distance_km, 3.4, 'a scene prints one decimal, not 3.42');
  assert.equal(outputs.station_count, 3);
  assert.equal(outputs.updated_at, '06/08/2026 à 07:12');
});

test('cheapest_station answers found=false instead of failing the scene', async () => {
  // The user follows diesel stations only: asking for LPG is not an error, it
  // is an answer the scene gates on with "only continue if".
  const { gladys, context } = scenario([station('1', 1.699)]);

  const outputs = await cheapestStation(gladys, { fuel: 'gplc' }, context);

  assert.deepEqual(outputs, { found: false, station_count: 0 });
});

test('cheapest_station reads the feed again only when the scene asked for it', async () => {
  const { gladys, provider, context } = scenario([station('1', 1.699), station('2', 1.659)]);

  await cheapestStation(gladys, { fuel: 'gazole' }, context);
  const withoutRefresh = provider.calls.fetchByIds.length;

  await cheapestStation(gladys, { fuel: 'gazole', refresh: true }, context);

  assert.ok(
    provider.calls.fetchByIds.length > withoutRefresh,
    'refresh: true must bypass the cache',
  );
});

test('price_report writes one line a notification can carry as is', async () => {
  const { gladys, context } = scenario([
    station('1', 1.729),
    station('2', 1.659),
    station('3', 1.699),
  ]);

  const outputs = await priceReport(gladys, { fuel: 'gazole', max_stations: 2 }, context);

  assert.equal(outputs.text, 'Gazole : Station 2 1,659 €/L · Station 3 1,699 €/L');
  assert.equal(outputs.station_count, 3, 'the count is what is followed, not what is listed');
  assert.equal(outputs.cheapest_price, 1.659);
});

test('price_report says so when nothing is followed for that fuel', async () => {
  const { gladys, context } = scenario([station('1', 1.699)]);

  const outputs = await priceReport(gladys, { fuel: 'e85' }, context);

  assert.match(outputs.text, /Aucune station/);
  assert.equal(outputs.station_count, 0);
});

test('an action never answers a key it did not declare', async () => {
  const { gladys, context } = scenario([station('1', 1.699), station('2', 1.659)]);

  for (const [key, handler] of Object.entries(SCENE_ACTIONS)) {
    const outputs = await handler(gladys, { fuel: 'gazole' }, context);
    const declared = new Set(SCENE_ACTION_CONTRACT[key].outputs);
    for (const outputKey of Object.keys(outputs)) {
      assert.ok(declared.has(outputKey), `"${key}" answers "${outputKey}", declared nowhere`);
    }
  }
});

test('every declared action is registered on the SDK member', () => {
  const registered = [];
  const gladys = { onSceneAction: (key, callback) => registered.push({ key, callback }) };

  registerSceneActions(gladys, { context: () => ({}) });

  assert.deepEqual(
    registered.map((r) => r.key),
    Object.keys(SCENE_ACTIONS),
  );
});

test('a registered action reads the configuration in force when the scene runs', async () => {
  // The whole reason `context` is a function: a scene started an hour after an
  // onConfigUpdated must act on the postal code the user saved, not the one
  // this module saw at startup.
  const registered = new Map();
  const gladys = { onSceneAction: (key, callback) => registered.set(key, callback) };
  let current = { postalCode: '35000' };
  const seen = [];

  registerSceneActions(gladys, {
    handlers: { echo: async (_gladys, fields, context) => seen.push({ fields, context }) },
    context: () => current,
  });

  await registered.get('echo')({ fuel: 'gazole' });
  current = { postalCode: '44000' };
  // A core that resolved no field at all sends none: the handler still runs.
  await registered.get('echo')();

  assert.deepEqual(
    seen.map((call) => call.context.postalCode),
    ['35000', '44000'],
  );
  assert.deepEqual(seen[1].fields, {}, 'a missing fields object is an empty one');
});

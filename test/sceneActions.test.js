// -----------------------------------------------------------------------------
// Scene actions (GladysAssistant/Gladys#3110, not released yet).
//
// Two things are tested here, and the second one matters as much as the first:
// what the handlers answer, and the fact that the SDK — the REAL one, not a
// stand-in — actually routes `external-integration.scene-action.run` to them.
// The SDK ignores unknown message types silently by design, so a broken
// registration would show up as scenes timing out with nothing in the logs.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GladysIntegration, createLogger } from '@gladysassistant/integration-sdk';
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

test('the handlers are registered through the SDK member as soon as it exists', () => {
  const registered = [];
  const gladys = { onSceneAction: (key, callback) => registered.push({ key, callback }) };

  const mode = registerSceneActions(gladys, { context: () => ({}) });

  assert.equal(mode, 'sdk');
  assert.deepEqual(
    registered.map((r) => r.key),
    Object.keys(SCENE_ACTIONS),
  );
});

// --- The fallback, against the real SDK --------------------------------------
// `onSceneAction` does not exist in the SDK yet and an unknown WebSocket
// message type is dropped silently, so the integration intercepts that one
// message itself. These tests run on a real GladysIntegration (never connected)
// so they break the day the SDK internals they lean on change — which is
// exactly when this fallback must be replaced by the SDK member.

/** A real, unconnected SDK instance whose `command-result` acks are captured. */
function sdkInstance() {
  const gladys = new GladysIntegration({
    hostApiUrl: 'http://127.0.0.1:1',
    token: 'test-token',
    selector: 'prix-carburants',
    logger: createLogger({ level: 'silent' }),
  });
  const sent = [];
  gladys._send = (type, payload) => sent.push({ type, payload });
  return { gladys, sent };
}

/** Feed a WebSocket frame to the SDK the way the socket does. */
const deliver = (gladys, message) => gladys._handleMessage(Buffer.from(JSON.stringify(message)));

test('the fallback answers a scene action with the declared outputs', async () => {
  const { gladys, sent } = sdkInstance();
  const mode = registerSceneActions(gladys, {
    handlers: { echo: async (_gladys, fields) => ({ seen: fields.value }) },
    context: () => ({}),
  });
  assert.equal(mode, 'fallback');

  await deliver(gladys, {
    type: 'external-integration.scene-action.run',
    payload: { message_id: 'abc', key: 'echo', fields: { value: 'gazole' } },
  });

  assert.deepEqual(sent, [
    {
      type: 'external-integration.command-result',
      payload: { message_id: 'abc', success: true, data: { outputs: { seen: 'gazole' } } },
    },
  ]);
});

test('the fallback reports a failing action instead of leaving the scene waiting', async () => {
  const { gladys, sent } = sdkInstance();
  registerSceneActions(gladys, {
    handlers: {
      broken: async () => {
        throw new Error('open data unreachable');
      },
    },
    context: () => ({}),
  });

  await deliver(gladys, {
    type: 'external-integration.scene-action.run',
    payload: { message_id: 'abc', key: 'broken' },
  });

  assert.equal(sent[0].payload.success, false);
  assert.equal(sent[0].payload.error, 'open data unreachable');
});

test('an action key this version does not know is answered, not ignored', async () => {
  const { gladys, sent } = sdkInstance();
  registerSceneActions(gladys, { handlers: {}, context: () => ({}) });

  await deliver(gladys, {
    type: 'external-integration.scene-action.run',
    payload: { message_id: 'abc', key: 'removed_last_version' },
  });

  assert.deepEqual(sent, [
    {
      type: 'external-integration.command-result',
      payload: { message_id: 'abc', success: false, error: 'not implemented' },
    },
  ]);
});

test('every other message keeps reaching the SDK untouched', async () => {
  const { gladys, sent } = sdkInstance();
  registerSceneActions(gladys, { handlers: {}, context: () => ({}) });
  const polled = [];
  gladys.onPoll(async (device) => polled.push(device));

  await deliver(gladys, {
    type: 'external-integration.device.poll',
    payload: { message_id: 'xyz', device: { external_id: 'ext:prix-carburants:fuel-station:x' } },
  });
  // A frame that is not even JSON must not throw either: the SDK ignores it.
  await gladys._handleMessage(Buffer.from('not json at all'));

  assert.equal(polled.length, 1, 'the poll handler still runs');
  assert.equal(sent[0].payload.message_id, 'xyz');
});

test('the scene actions are lost, never the integration, on an unknown SDK', () => {
  const mode = registerSceneActions({ handlers: {} }, { context: () => ({}) });

  assert.equal(mode, 'unsupported');
});

// -----------------------------------------------------------------------------
// The refresh loop replaces the Gladys polling the devices cannot ask for
// (Gladys' poll_frequency stops at one minute), so it is what actually keeps
// the prices alive: it deserves the same scrutiny as the discovery payload.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { createRefreshLoop, refreshAllDevices } from '../src/refresh.js';
import { deviceExternalId } from '../src/devices/index.js';
import { createStationStore } from '../src/stationStore.js';
import { createPriceHistory } from '../src/priceHistory.js';
import { createSceneEvents, SCENE_TRIGGERS } from '../src/sceneEvents.js';
import { createFakeGladys, createFakeProvider, createStation } from './helpers/fakeGladys.js';

const config = normalizeConfig({ postal_code: '35000', fuel_type: ['gazole'] });

function storeWith(stations) {
  const provider = createFakeProvider({ stations });
  return { provider, store: createStationStore({ resolveProvider: () => provider }) };
}

/** A fake Gladys already holding one device per given station id. */
function gladysWithStations(ids) {
  const gladys = createFakeGladys();
  gladys.devices = ids.map((stationId) => ({
    external_id: deviceExternalId(gladys, { country: 'FR', stationId, fuel: 'gazole' }),
  }));
  return gladys;
}

/** setInterval/clearInterval stand-in: the test fires the tick itself. */
function fakeTimers() {
  const armed = [];
  return {
    armed,
    setTimer: (callback, intervalMs) => {
      const handle = { callback, intervalMs, cleared: false };
      armed.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      handle.cleared = true;
    },
    /** Run the callback of the timer currently armed. */
    tick: () => armed[armed.length - 1].callback(),
  };
}

test('refreshAllDevices does nothing when no station was added', async () => {
  const { provider, store } = storeWith([createStation()]);
  const result = await refreshAllDevices(createFakeGladys({ devices: [] }), { config, store });

  assert.deepEqual(result, { total: 0, updated: 0, failures: [] });
  assert.deepEqual(provider.calls.fetchByIds, [], 'nothing to read means no request');
});

test('refreshAllDevices publishes the price of every added station', async () => {
  const { store } = storeWith([createStation({ id: '1' }), createStation({ id: '2' })]);
  const gladys = gladysWithStations(['1', '2']);

  const result = await refreshAllDevices(gladys, { config, store });

  assert.deepEqual(result, { total: 2, updated: 2, failures: [] });
  assert.equal(gladys.published.filter((p) => p.featureExternalId.endsWith(':price')).length, 2);
});

test('refreshAllDevices batches the whole country in one request', async () => {
  const { provider, store } = storeWith([createStation({ id: '1' }), createStation({ id: '2' })]);

  await refreshAllDevices(gladysWithStations(['1', '2']), { config, store });

  assert.equal(provider.calls.fetchByIds.length, 1, 'two devices, one HTTP call');
});

test('refreshAllDevices reports the stations it could not read without stopping', async () => {
  const { store } = storeWith([createStation({ id: '1' })]);
  const gladys = gladysWithStations(['gone', '1']);

  const result = await refreshAllDevices(gladys, { config, store });

  assert.equal(result.total, 2);
  assert.equal(result.updated, 1, 'the station after the failing one is still read');
  assert.equal(result.failures.length, 1);
});

test('the loop arms a timer at the configured interval, in milliseconds', () => {
  const { store } = storeWith([createStation()]);
  const timers = fakeTimers();
  const loop = createRefreshLoop(createFakeGladys(), { store, ...timers });

  loop.start(normalizeConfig({ postal_code: '35000', poll_frequency: 1800 }));

  assert.equal(timers.armed.length, 1);
  assert.equal(timers.armed[0].intervalMs, 1_800_000);
});

test('restarting the loop replaces the previous timer instead of stacking one', () => {
  const { store } = storeWith([createStation()]);
  const timers = fakeTimers();
  const loop = createRefreshLoop(createFakeGladys(), { store, ...timers });

  loop.start(config);
  loop.start(normalizeConfig({ postal_code: '35000', poll_frequency: 600 }));

  assert.equal(timers.armed.length, 2);
  assert.equal(timers.armed[0].cleared, true, 'the interval the user replaced must be disarmed');
  assert.equal(timers.armed[1].cleared, false);

  loop.stop();
  assert.equal(timers.armed[1].cleared, true);
});

test('a tick refreshes the prices', async () => {
  const { store } = storeWith([createStation({ id: '1' })]);
  const gladys = gladysWithStations(['1']);
  const timers = fakeTimers();
  const loop = createRefreshLoop(gladys, { store, ...timers });

  loop.start(config);
  await timers.tick();

  assert.deepEqual(gladys.published, [
    { featureExternalId: gladys.devices[0].external_id + ':price', state: 1.699 },
    {
      featureExternalId: gladys.devices[0].external_id + ':updated_at',
      state: { text: '06/08/2026 à 07:12' },
    },
  ]);
});

test('a failing tick never rejects: a timer callback must not crash the container', async () => {
  const store = {
    invalidate() {},
    setTracked() {},
    async getStation() {
      throw new Error('open data API is down');
    },
  };
  const gladys = gladysWithStations(['1']);
  const loop = createRefreshLoop(gladys, { store, ...fakeTimers() });

  await loop.runNow(config); // rejecting here would be an unhandled rejection
  assert.deepEqual(gladys.published, []);
});

test('a tick fired while the previous one is still running is skipped', async () => {
  let reads = 0;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const store = {
    invalidate() {},
    setTracked() {},
    async getStation() {
      reads += 1;
      await blocked;
      return null;
    },
  };
  const gladys = gladysWithStations(['1']);
  const loop = createRefreshLoop(gladys, { store, ...fakeTimers() });

  const first = loop.runNow(config);
  await loop.runNow(config); // the API call is still in flight
  release();
  await first;

  assert.equal(reads, 1, 'the second tick must not queue a second round of requests');
});

test('the loop keeps the widget curve filling when no dashboard is open', async () => {
  const gladys = createFakeGladys();
  const provider = createFakeProvider({ stations: [createStation({ prices: { gazole: 1.6 } })] });
  const store = createStationStore({ resolveProvider: () => provider });
  const history = createPriceHistory({ file: '/etc/hostname/nope.json' });

  // Nothing follows this area yet: no card anywhere, so no search is paid for.
  await refreshAllDevices(gladys, { config, store, history });
  assert.equal(provider.calls.search, 0);

  // A widget pull records a first point; from then on the loop keeps it alive.
  history.record(config, await store.search(config));
  const searchesAfterTheWidget = provider.calls.search;
  store.invalidate();
  await refreshAllDevices(gladys, { config, store, history });
  assert.equal(provider.calls.search, searchesAfterTheWidget, 'not twice within the hour');
});

// --- Scene triggers ----------------------------------------------------------
// The pass is where the events are decided, so this is where "a refresh that
// changed nothing wakes no scene" has to be asserted end to end.

test('a refresh pass fires the scene trigger of a price that actually moved', async () => {
  const station = createStation({ id: '1' });
  const { store } = storeWith([station]);
  const gladys = gladysWithStations(['1']);
  const sent = [];
  const sceneEvents = createSceneEvents(gladys, {
    publish: async (_gladys, key, data) => sent.push({ key, data }),
  });

  await refreshAllDevices(gladys, { config, store, sceneEvents });
  assert.deepEqual(sent, [], 'the first pass is the baseline');

  await refreshAllDevices(gladys, { config, store, force: true, sceneEvents });
  assert.deepEqual(sent, [], 'the same price twice is not an event');

  station.prices = { ...station.prices, gazole: 1.659 };
  await refreshAllDevices(gladys, { config, store, force: true, sceneEvents });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].key, SCENE_TRIGGERS.PRICE_UPDATED);
  assert.equal(sent[0].data.price, 1.659);
  assert.equal(sent[0].data.previous_price, 1.699);
});

test('a pass where every station failed fires the feed trigger', async () => {
  const { provider, store } = storeWith([createStation({ id: '1' })]);
  const gladys = gladysWithStations(['1']);
  const sent = [];
  const sceneEvents = createSceneEvents(gladys, {
    publish: async (_gladys, key, data) => sent.push({ key, data }),
  });

  await refreshAllDevices(gladys, { config, store, sceneEvents });

  provider.fetchStationsByIds = async () => {
    throw new Error('fetch failed (ECONNREFUSED)');
  };
  const result = await refreshAllDevices(gladys, { config, store, force: true, sceneEvents });

  assert.equal(result.failures.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].key, SCENE_TRIGGERS.FEED_STATUS_CHANGED);
  assert.equal(sent[0].data.status, 'unavailable');
  assert.match(sent[0].data.error, /ECONNREFUSED/);
});

test('an unpublishable scene event never fails the refresh that carried it', async () => {
  const station = createStation({ id: '1' });
  const { store } = storeWith([station]);
  const gladys = gladysWithStations(['1']);
  const sceneEvents = createSceneEvents(gladys, {
    publish: async () => {
      throw new Error('core unreachable');
    },
  });

  await refreshAllDevices(gladys, { config, store, sceneEvents });
  station.prices = { ...station.prices, gazole: 1.659 };
  const result = await refreshAllDevices(gladys, { config, store, force: true, sceneEvents });

  assert.deepEqual(result, { total: 1, updated: 1, failures: [] }, 'the prices were refreshed');
});

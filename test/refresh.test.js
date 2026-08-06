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
      state: { text: '2026-08-06T07:12:00+02:00' },
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

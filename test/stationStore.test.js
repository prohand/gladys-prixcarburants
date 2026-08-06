// -----------------------------------------------------------------------------
// The store exists to protect the open data API from the polling pattern of
// Gladys (one poll per device). These tests are about counting requests.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStationStore } from '../src/stationStore.js';
import { createFakeProvider, createStation } from './helpers/fakeGladys.js';

const stations = [
  createStation({ id: '1' }),
  createStation({ id: '2' }),
  createStation({ id: '3' }),
];

function createStore(options = {}) {
  const provider = createFakeProvider({ stations });
  return { provider, store: createStationStore({ resolveProvider: () => provider, ...options }) };
}

test('ten polls of ten stations cost one request', async () => {
  const { provider, store } = createStore();
  store.setTracked(stations.map((s) => ({ country: 'FR', stationId: s.id })));

  await Promise.all(stations.map((s) => store.getStation('FR', s.id)));

  assert.equal(provider.calls.fetchByIds.length, 1, 'a single batched request');
  assert.deepEqual(provider.calls.fetchByIds[0], ['1', '2', '3']);
});

test('a cached station is served without touching the provider', async () => {
  const { provider, store } = createStore();
  store.track('FR', '1');

  await store.getStation('FR', '1');
  await store.getStation('FR', '1');

  assert.equal(provider.calls.fetchByIds.length, 1);
});

test('a stale station triggers a new request', async () => {
  let clock = 0;
  const { provider, store } = createStore({ ttlMs: 1000, now: () => clock });
  store.track('FR', '1');

  await store.getStation('FR', '1');
  clock += 5000;
  await store.getStation('FR', '1');

  assert.equal(provider.calls.fetchByIds.length, 2);
});

test('a station polled before being tracked is fetched anyway', async () => {
  const { provider, store } = createStore();

  const station = await store.getStation('FR', '2');

  assert.equal(station.id, '2');
  assert.deepEqual(provider.calls.fetchByIds[0], ['2']);
});

test('search caches its results, so adding a station right after costs nothing', async () => {
  const { provider, store } = createStore();

  await store.search({
    country: 'FR',
    postal_code: '35000',
    search_radius_km: 10,
    max_stations: 20,
  });
  await store.getStation('FR', '1');

  assert.equal(provider.calls.search, 1);
  assert.equal(provider.calls.fetchByIds.length, 0);
});

test('invalidate forces the next read to hit the provider', async () => {
  const { provider, store } = createStore();
  store.track('FR', '1');

  await store.getStation('FR', '1');
  store.invalidate();
  await store.getStation('FR', '1');

  assert.equal(provider.calls.fetchByIds.length, 2);
});

test('untracking a station stops refreshing it', async () => {
  const { provider, store } = createStore();
  store.setTracked([
    { country: 'FR', stationId: '1' },
    { country: 'FR', stationId: '2' },
  ]);

  store.untrack('FR', '1');
  await store.getStation('FR', '2');

  assert.deepEqual(provider.calls.fetchByIds[0], ['2']);
  assert.deepEqual(
    store.trackedStations.map((s) => s.stationId),
    ['2'],
  );
});

test('a station missing from the feed keeps its last known price', async () => {
  const provider = createFakeProvider({ stations });
  const store = createStationStore({ ttlMs: 0, resolveProvider: () => provider });
  store.track('FR', '1');

  await store.getStation('FR', '1');
  // The station disappears from the feed (roadworks, delisting…).
  provider.fetchStationsByIds = async () => [];

  assert.equal(store.peek('FR', '1').prices.gazole, 1.699);
});

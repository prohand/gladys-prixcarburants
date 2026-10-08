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

test('a refresh by id keeps the distance the last search measured', async () => {
  // The real provider measures distances on a search only: a station read back
  // by id has none, and the station card lost its distance row with it.
  const provider = createFakeProvider({ stations: [createStation({ id: '1', distanceKm: 2.5 })] });
  const store = createStationStore({ resolveProvider: () => provider });
  const config = { country: 'FR', postal_code: '35000', search_radius_km: 10, max_stations: 5 };
  await store.search(config);
  provider.fetchStationsByIds = async () => [createStation({ id: '1', distanceKm: undefined })];

  store.invalidate();
  const refreshed = await store.getStation('FR', '1');

  assert.equal(refreshed.distanceKm, 2.5);
});

test('clear forgets the stations, distances included', async () => {
  const provider = createFakeProvider({ stations: [createStation({ id: '1', distanceKm: 2.5 })] });
  const store = createStationStore({ resolveProvider: () => provider });
  await store.search({ country: 'FR', postal_code: '35000', search_radius_km: 10 });
  provider.fetchStationsByIds = async () => [createStation({ id: '1', distanceKm: undefined })];

  store.clear();
  const refreshed = await store.getStation('FR', '1');

  assert.equal(store.peek('FR', '2'), null);
  assert.equal(refreshed.distanceKm, undefined);
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

test('two cards searching at the same moment cost one search', async () => {
  // The two dashboard widgets pull side by side, and a cold search walks
  // concentric circles with one HTTP request per ring: doing it twice at once
  // is how a pull runs past the core's 15 s ack deadline and the card comes
  // back "data unavailable".
  const { provider, store } = createStore();
  const config = { country: 'FR', postal_code: '35000', search_radius_km: 10, max_stations: 20 };

  const [first, second] = await Promise.all([store.search(config), store.search(config)]);

  assert.equal(provider.calls.search, 1, 'one call for two cards');
  assert.deepEqual(first, second, 'both cards get the same stations');

  // A later search is served from the result cache (see below): still one.
  await store.search(config);
  assert.equal(provider.calls.search, 1);
});

test('a search for other criteria is not served by the one in flight', async () => {
  const { provider, store } = createStore();
  const near = { country: 'FR', postal_code: '35000', search_radius_km: 5, max_stations: 20 };
  const far = { ...near, search_radius_km: 30 };

  await Promise.all([store.search(near), store.search(far)]);

  assert.equal(provider.calls.search, 2, 'a different radius is a different search');
});

test('a search result is reused for a few minutes, then searched again', async () => {
  let clock = 0;
  const { provider, store } = createStore({ now: () => clock, searchTtlMs: 5 * 60 * 1000 });
  const config = { country: 'FR', postal_code: '35000', search_radius_km: 10, max_stations: 20 };

  await store.search(config);
  clock += 4 * 60 * 1000;
  const again = await store.search(config);
  assert.equal(provider.calls.search, 1, 'every card pull used to pay 2 to 6 requests here');
  assert.deepEqual(
    again.map((s) => s.id),
    ['1', '2', '3'],
  );

  clock += 2 * 60 * 1000;
  await store.search(config);
  assert.equal(provider.calls.search, 2, 'past the TTL, a real search');
});

test('a cached search shows the price the refresh pass read since', async () => {
  const { provider, store } = createStore();
  const config = { country: 'FR', postal_code: '35000', search_radius_km: 10, max_stations: 20 };
  await store.search(config);

  // The refresh pass re-reads station 1 by id (no distance in that answer),
  // and its price moved since the search.
  provider.fetchStationsByIds = async () => [
    createStation({ id: '1', prices: { gazole: 1.5 }, distanceKm: undefined }),
  ];
  store.track('FR', '1');
  await store.refreshTracked('FR');

  const listed = await store.search(config);
  assert.equal(provider.calls.search, 1, 'served from the cached list');
  const station = listed.find((s) => s.id === '1');
  assert.equal(station.prices.gazole, 1.5, 'the list must not hide the new price');
  assert.equal(station.distanceKm, 1.2, 'and keeps the distance the search measured');
});

test('changing the criteria or asking for a real read drops the cached list', async () => {
  const { provider, store } = createStore();
  const config = { country: 'FR', postal_code: '35000', search_radius_km: 10, max_stations: 20 };

  await store.search(config);
  await store.search({ ...config, search_center: 'house', house_name: 'Bureau' });
  assert.equal(provider.calls.search, 2, 'another centre is another search');

  store.clear(); // onConfigUpdated
  await store.search(config);
  assert.equal(provider.calls.search, 3);

  store.invalidate(); // the "refresh now" button
  await store.search(config);
  assert.equal(provider.calls.search, 4);
});

test('a failed search is not cached', async () => {
  const { provider, store } = createStore();
  const config = { country: 'FR', postal_code: '35000', search_radius_km: 10, max_stations: 20 };
  const search = provider.searchStations;
  provider.searchStations = async () => {
    provider.searchStations = search;
    throw new Error('open data API is down');
  };

  await assert.rejects(store.search(config));
  await store.search(config);
  assert.equal(provider.calls.search, 1, 'the second call really searched');
});

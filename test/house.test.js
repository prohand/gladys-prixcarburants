// -----------------------------------------------------------------------------
// House coordinates.
//
// The route is optional by nature: a user who never located their house, an
// older core, a manifest without `"location": true` — all of them must land on
// the same place, the postal code, without an error anywhere. These tests pin
// that down, and the one hour of cache that keeps the widgets from asking on
// every pull.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHouseLocation, resolveSearchCenter } from '../src/house.js';
import { normalizeConfig } from '../src/config.js';

const gladys = { hostApiUrl: 'http://gladys:1443', token: 'jwt' };

/** A `fetch` answering a scripted response and counting its calls. */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) {
      throw next;
    }
    return {
      ok: next.status === undefined || next.status < 400,
      status: next.status ?? 200,
      json: async () => next.body,
    };
  };
  return { fetchImpl, calls };
}

const HOUSES = [
  { id: '1', name: 'Maison', selector: 'maison', latitude: 48.1113, longitude: -1.6845 },
];

test('the located house is read from the integration host API', async () => {
  const { fetchImpl, calls } = fakeFetch([{ body: HOUSES }]);
  const house = createHouseLocation(gladys, { fetchImpl });

  assert.deepEqual(await house.get(), {
    name: 'Maison',
    latitude: 48.1113,
    longitude: -1.6845,
  });
  assert.equal(calls[0].url, 'http://gladys:1443/api/integration/v1/house');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer jwt');
});

test('the first house that actually has coordinates wins', async () => {
  const { fetchImpl } = fakeFetch([
    {
      body: [{ id: '1', name: 'Bureau', latitude: null, longitude: null }, ...HOUSES],
    },
  ]);
  const house = createHouseLocation(gladys, { fetchImpl });

  assert.equal((await house.get()).name, 'Maison');
});

test('a house nobody located gives null, not an error', async () => {
  const { fetchImpl } = fakeFetch([
    { body: [{ id: '1', name: 'Maison', latitude: null, longitude: null }] },
  ]);
  const house = createHouseLocation(gladys, { fetchImpl });

  assert.equal(await house.get(), null);
});

test('a 403 (no "location" in the manifest, or an older core) gives null', async () => {
  const { fetchImpl } = fakeFetch([{ status: 403, body: {} }]);
  const house = createHouseLocation(gladys, { fetchImpl });

  assert.equal(await house.get(), null);
});

test('a network failure gives null rather than breaking the pull', async () => {
  const { fetchImpl } = fakeFetch([new Error('ECONNREFUSED')]);
  const house = createHouseLocation(gladys, { fetchImpl });

  assert.equal(await house.get(), null);
});

test('the answer is cached, and concurrent pulls share one call', async () => {
  const { fetchImpl, calls } = fakeFetch([{ body: HOUSES }]);
  let clock = 0;
  const house = createHouseLocation(gladys, { fetchImpl, now: () => clock, ttlMs: 1000 });

  const [first, second] = await Promise.all([house.get(), house.get()]);
  assert.deepEqual(first, second);
  await house.get();
  assert.equal(calls.length, 1, 'one call for three asks');

  clock += 2000;
  await house.get();
  assert.equal(calls.length, 2, 'asked again once the cache expired');

  house.invalidate();
  await house.get();
  assert.equal(calls.length, 3, 'a configuration change asks again right away');
});

test('the search centre follows the configuration, and falls back on its own', async () => {
  const onHouse = normalizeConfig({ postal_code: '35000' });
  const onPostalCode = normalizeConfig({ postal_code: '35000', search_center: 'postal_code' });
  assert.equal(onHouse.search_center, 'house', 'the house is the default');

  const located = createHouseLocation(gladys, {
    fetchImpl: fakeFetch([{ body: HOUSES }]).fetchImpl,
  });
  assert.deepEqual(await resolveSearchCenter(onHouse, located), {
    center: { latitude: 48.1113, longitude: -1.6845 },
    source: 'house',
  });

  // Asked for the postal code: the house is not even queried.
  const { fetchImpl, calls } = fakeFetch([{ body: HOUSES }]);
  const unused = createHouseLocation(gladys, { fetchImpl });
  assert.deepEqual(await resolveSearchCenter(onPostalCode, unused), {
    center: null,
    source: 'postal_code',
  });
  assert.equal(calls.length, 0);

  // Asked for the house, but nothing is located: same answer as the postal code.
  const unlocated = createHouseLocation(gladys, {
    fetchImpl: fakeFetch([{ body: [] }]).fetchImpl,
  });
  assert.deepEqual(await resolveSearchCenter(onHouse, unlocated), {
    center: null,
    source: 'postal_code',
  });

  // No house module at all (an older wiring): still fine.
  assert.deepEqual(await resolveSearchCenter(onHouse, undefined), {
    center: null,
    source: 'postal_code',
  });
});

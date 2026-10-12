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

/**
 * An SDK whose `getHouses()` answers scripted responses and counts its calls: a
 * body, an HTTP refusal (`{ status }`, thrown like the SDK's GladysApiError) or
 * an Error (a network failure, which carries no status).
 */
function fakeGladys(responses) {
  const calls = [];
  const queue = [...responses];
  const gladys = {
    getHouses: async () => {
      calls.push('getHouses');
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) {
        throw next;
      }
      if (next.status !== undefined && next.status >= 400) {
        throw Object.assign(new Error(`HTTP ${next.status}`), {
          name: 'GladysApiError',
          status: next.status,
        });
      }
      return next.body;
    },
  };
  return { gladys, calls };
}

const HOUSES = [
  { id: '1', name: 'Maison', selector: 'maison', latitude: 48.1113, longitude: -1.6845 },
];

test('the located house is read through the SDK', async () => {
  const { gladys, calls } = fakeGladys([{ body: HOUSES }]);
  const house = createHouseLocation(gladys);

  assert.deepEqual(await house.get(), {
    name: 'Maison',
    selector: 'maison',
    latitude: 48.1113,
    longitude: -1.6845,
  });
  assert.deepEqual(calls, ['getHouses']);
});

test('the first house that actually has coordinates wins', async () => {
  const { gladys } = fakeGladys([
    {
      body: [{ id: '1', name: 'Bureau', latitude: null, longitude: null }, ...HOUSES],
    },
  ]);
  const house = createHouseLocation(gladys);

  assert.equal((await house.get()).name, 'Maison');
});

test('every located house is offered, and the configuration names the one used', async () => {
  // A Gladys install can hold several houses (a home and a holiday house). The
  // configuration picks one in a `source: "houses"` select, which stores its
  // SELECTOR; a name typed before that select existed is matched loosely:
  // trimmed, case- and accent-insensitive.
  const houses = [
    { id: '1', name: 'Maison', selector: 'maison', latitude: 48.1113, longitude: -1.6845 },
    {
      id: '2',
      name: 'Résidence d’été',
      selector: 'residence-d-ete',
      latitude: 43.2961,
      longitude: 5.3699,
    },
  ];
  const house = createHouseLocation(fakeGladys([{ body: houses }]).gladys);

  assert.deepEqual(await house.names(), ['Maison', 'Résidence d’été']);
  assert.equal((await house.get('residence-d-ete')).latitude, 43.2961, 'picked in the list');
  assert.equal((await house.get('Résidence d’été')).latitude, 43.2961, 'typed by name');
  assert.equal((await house.get('  residence d’ete ')).latitude, 43.2961, 'matched loosely');
  assert.equal((await house.get()).name, 'Maison', 'no name configured: the first one');
  assert.equal((await house.get('')).name, 'Maison', 'an empty field is no name at all');
  assert.equal(
    (await house.get('Chalet')).name,
    'Maison',
    'a name that matches nothing falls back rather than dropping the distances',
  );
});

test('the house named in the configuration is the one the search is centred on', async () => {
  const houses = [
    { id: '1', name: 'Maison', latitude: 48.1113, longitude: -1.6845 },
    { id: '2', name: 'Bureau', latitude: 43.2961, longitude: 5.3699 },
  ];
  const house = createHouseLocation(fakeGladys([{ body: houses }]).gladys);
  const config = normalizeConfig({ postal_code: '35000', house_name: 'Bureau' });

  assert.deepEqual(await resolveSearchCenter(config, house), {
    center: { latitude: 43.2961, longitude: 5.3699 },
    source: 'house',
    // Named because Gladys holds two: "my home" would not say which one.
    houseName: 'Bureau',
  });
});

test('the house picked in the list wins over the name typed before it existed', async () => {
  const houses = [
    { id: '1', name: 'Maison', selector: 'maison', latitude: 48.1113, longitude: -1.6845 },
    { id: '2', name: 'Bureau', selector: 'bureau', latitude: 43.2961, longitude: 5.3699 },
  ];
  const house = createHouseLocation(fakeGladys([{ body: houses }]).gladys);

  const picked = normalizeConfig({ postal_code: '35000', house: 'maison', house_name: 'Bureau' });
  assert.equal((await resolveSearchCenter(picked, house)).houseName, 'Maison');

  // An install that never opened the form again keeps its typed name.
  const typed = normalizeConfig({ postal_code: '35000', house_name: 'Bureau' });
  assert.equal((await resolveSearchCenter(typed, house)).houseName, 'Bureau');
});

test('a house read that hangs is given up like a blip', async () => {
  const gladys = { getHouses: () => new Promise(() => {}) };
  const house = createHouseLocation(gladys, { timeoutMs: 10 });

  assert.equal(await house.get(), null, 'the postal code serves meanwhile');
});

test('a single house is not named: "my home" says it all', async () => {
  const houses = [{ id: '1', name: 'Maison', latitude: 48.1113, longitude: -1.6845 }];
  const house = createHouseLocation(fakeGladys([{ body: houses }]).gladys);
  const config = normalizeConfig({ postal_code: '35000' });

  assert.equal((await resolveSearchCenter(config, house)).houseName, undefined);
});

test('a house nobody located gives null, not an error', async () => {
  const { gladys } = fakeGladys([
    { body: [{ id: '1', name: 'Maison', latitude: null, longitude: null }] },
  ]);
  const house = createHouseLocation(gladys);

  assert.equal(await house.get(), null);
  assert.deepEqual(await house.names(), [], 'nothing to offer in the Configuration screen');
});

test('a 403 (no "location" in the manifest, or an older core) gives null', async () => {
  const { gladys } = fakeGladys([{ status: 403, body: {} }]);
  const house = createHouseLocation(gladys);

  assert.equal(await house.get(), null);
});

test('a network failure gives null rather than breaking the pull', async () => {
  const { gladys } = fakeGladys([new Error('ECONNREFUSED')]);
  const house = createHouseLocation(gladys);

  assert.equal(await house.get(), null);
});

test('the answer is cached, and concurrent pulls share one call', async () => {
  const { gladys, calls } = fakeGladys([{ body: HOUSES }]);
  let clock = 0;
  const house = createHouseLocation(gladys, { now: () => clock, ttlMs: 1000 });

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

  const located = createHouseLocation(fakeGladys([{ body: HOUSES }]).gladys);
  assert.deepEqual(await resolveSearchCenter(onHouse, located), {
    center: { latitude: 48.1113, longitude: -1.6845 },
    source: 'house',
  });

  // Asked for the postal code: the house is not even queried.
  const { gladys, calls } = fakeGladys([{ body: HOUSES }]);
  const unused = createHouseLocation(gladys);
  assert.deepEqual(await resolveSearchCenter(onPostalCode, unused), {
    center: null,
    source: 'postal_code',
  });
  assert.equal(calls.length, 0);

  // Asked for the house, but nothing is located: same answer as the postal code.
  const unlocated = createHouseLocation(fakeGladys([{ body: [] }]).gladys);
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

test('a transient failure is retried within minutes, not after an hour', async () => {
  for (const failure of [new Error('ECONNREFUSED'), { status: 503, body: {} }, { status: 429 }]) {
    const { gladys, calls } = fakeGladys([failure, { body: HOUSES }]);
    let clock = 0;
    const house = createHouseLocation(gladys, {
      now: () => clock,
      ttlMs: 60 * 60 * 1000,
      failureTtlMs: 2 * 60 * 1000,
    });

    assert.equal(await house.get(), null, 'the postal code serves meanwhile');
    clock += 60 * 1000;
    assert.equal(await house.get(), null, 'not asked again on every pull');
    assert.equal(calls.length, 1);

    clock += 2 * 60 * 1000;
    assert.equal((await house.get()).name, 'Maison', 'asked again a couple of minutes later');
    assert.equal(calls.length, 2);
  }
});

test('a 403 is no blip: it is kept for the hour', async () => {
  const { gladys, calls } = fakeGladys([{ status: 403, body: {} }, { body: HOUSES }]);
  let clock = 0;
  const house = createHouseLocation(gladys, {
    now: () => clock,
    ttlMs: 60 * 60 * 1000,
    failureTtlMs: 2 * 60 * 1000,
  });

  await house.get();
  clock += 10 * 60 * 1000;
  assert.equal(await house.get(), null);
  assert.equal(calls.length, 1, 'only re-installing fixes a missing "location": true');
});

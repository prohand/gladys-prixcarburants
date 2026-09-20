// -----------------------------------------------------------------------------
// Scene triggers (GladysAssistant/Gladys#3110, not released yet).
//
// What is actually worth asserting here is not "an event is sent" — it is the
// opposite: that nothing is sent when nothing happened. A trigger that fires on
// every refresh pass would wake a scene once an hour forever, and a trigger
// that fires on the first pass would do it at every container restart.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSceneEvents,
  FEED_STATUSES,
  PRICE_DIRECTIONS,
  SCENE_TRIGGERS,
  SCENE_TRIGGER_CONTRACT,
} from '../src/sceneEvents.js';
import { createStation } from './helpers/fakeGladys.js';

/** A scene-event publisher that records instead of calling the host API. */
function recorder(behaviour = () => {}) {
  const sent = [];
  const publish = async (gladys, key, data) => {
    sent.push({ key, data });
    return behaviour(key, data);
  };
  return { sent, publish };
}

/** One reading of a refresh pass, in the shape `refreshAllDevices` records. */
function reading(stationId, fuel, price, overrides = {}) {
  const station = createStation({
    id: stationId,
    name: `Station ${stationId}`,
    city: 'Rennes',
    ...overrides,
  });
  return {
    device: { external_id: `ext:prix-carburants:fuel-station:FR-${stationId}-${fuel}` },
    target: { country: 'FR', stationId, fuel },
    station,
    price,
  };
}

/** Run one pass over the given readings and return the events it fired. */
async function pass(sceneEvents, readings, outcome = {}) {
  const current = sceneEvents.startPass();
  readings.forEach((r) => current.record(r));
  return current.end(outcome);
}

test('the first pass only records: a restart is not a price change', async () => {
  const { sent, publish } = recorder();
  const events = createSceneEvents({}, { publish });

  const fired = await pass(events, [reading('1', 'gazole', 1.699)]);

  assert.deepEqual(fired, []);
  assert.deepEqual(sent, [], 'nothing happened yet, there is nothing to tell a scene');
});

test('a price that did not move fires nothing', async () => {
  const { sent, publish } = recorder();
  const events = createSceneEvents({}, { publish });

  await pass(events, [reading('1', 'gazole', 1.699)]);
  await pass(events, [reading('1', 'gazole', 1.699)]);
  await pass(events, [reading('1', 'gazole', 1.699)]);

  assert.deepEqual(sent, []);
});

test('a price that moved fires price_updated with the previous price and the gap', async () => {
  const { sent, publish } = recorder();
  const events = createSceneEvents({}, { publish });

  await pass(events, [reading('1', 'gazole', 1.722)]);
  await pass(events, [reading('1', 'gazole', 1.699)]);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].key, SCENE_TRIGGERS.PRICE_UPDATED);
  assert.equal(sent[0].data.price, 1.699);
  assert.equal(sent[0].data.previous_price, 1.722);
  // -0.023000000000000048 in binary floating point: a scene must not print that.
  assert.equal(sent[0].data.price_difference, -0.023);
  assert.equal(sent[0].data.direction, PRICE_DIRECTIONS.DOWN);
  assert.equal(sent[0].data.fuel, 'gazole');
  assert.equal(sent[0].data.fuel_label, 'Gazole');
  assert.equal(sent[0].data.station_name, 'Station 1');
  assert.equal(sent[0].data.updated_at, '06/08/2026 à 07:12');
  assert.match(sent[0].data.device, /fuel-station:FR-1-gazole$/, 'the device filter value');
});

test('a price going up is the same event, in the other direction', async () => {
  const { sent, publish } = recorder();
  const events = createSceneEvents({}, { publish });

  await pass(events, [reading('1', 'gazole', 1.699)]);
  await pass(events, [reading('1', 'gazole', 1.759)]);

  assert.equal(sent[0].data.direction, PRICE_DIRECTIONS.UP);
  assert.equal(sent[0].data.price_difference, 0.06);
});

test('every fired key is declared in the contract, and nothing else', async () => {
  const { sent, publish } = recorder();
  const events = createSceneEvents({}, { publish });

  // Two stations, so the "cheapest" trigger has a ranking to compute.
  await pass(events, [reading('1', 'gazole', 1.699), reading('2', 'gazole', 1.729)]);
  await pass(events, [reading('1', 'gazole', 1.799), reading('2', 'gazole', 1.729)], {
    failed: true,
    error: new Error('feed down'),
    lastSuccessAt: Date.parse('2026-08-06T07:12:00Z'),
  });

  assert.ok(sent.length >= 3, 'price, cheapest and feed status all moved');
  for (const { key, data } of sent) {
    const contract = SCENE_TRIGGER_CONTRACT[key];
    assert.ok(contract, `"${key}" is not a declared trigger`);
    const declared = new Set([...contract.filters, ...contract.variables]);
    for (const dataKey of Object.keys(data)) {
      assert.ok(declared.has(dataKey), `"${key}" sends "${dataKey}", declared nowhere`);
    }
    for (const dataKey of declared) {
      assert.ok(dataKey in data, `"${key}" declares "${dataKey}" but never sends it`);
    }
  }
});

test('the cheapest station of a fuel is a ranking, so it needs two stations', async () => {
  const { sent, publish } = recorder();
  const events = createSceneEvents({}, { publish });

  await pass(events, [reading('1', 'gazole', 1.699)]);
  await pass(events, [reading('1', 'gazole', 1.699), reading('2', 'gazole', 1.659)]);

  assert.deepEqual(
    sent.filter((e) => e.key === SCENE_TRIGGERS.CHEAPEST_STATION_CHANGED),
    [],
    'the first ranking is a baseline, not a change',
  );
});

test('cheapest_station_changed fires when the leader really changes', async () => {
  const { sent, publish } = recorder();
  const events = createSceneEvents({}, { publish });

  await pass(events, [reading('1', 'gazole', 1.699), reading('2', 'gazole', 1.729)]);
  sent.length = 0;
  await pass(events, [reading('1', 'gazole', 1.699), reading('2', 'gazole', 1.649)]);

  const [event] = sent.filter((e) => e.key === SCENE_TRIGGERS.CHEAPEST_STATION_CHANGED);
  assert.ok(event, 'station 2 is now the cheapest');
  assert.equal(event.data.station_name, 'Station 2');
  assert.equal(event.data.price, 1.649);
  assert.equal(event.data.previous_station_name, 'Station 1');
  assert.equal(event.data.previous_price, 1.699);
  assert.equal(event.data.price_difference, -0.05);
  assert.equal(event.data.station_count, 2);

  // The leader keeps the lead while its price moves: that is price_updated's
  // job, not a change of ranking.
  sent.length = 0;
  await pass(events, [reading('1', 'gazole', 1.699), reading('2', 'gazole', 1.639)]);
  assert.deepEqual(
    sent.filter((e) => e.key === SCENE_TRIGGERS.CHEAPEST_STATION_CHANGED),
    [],
  );
});

test('each fuel is ranked on its own', async () => {
  const { sent, publish } = recorder();
  const events = createSceneEvents({}, { publish });

  const first = [
    reading('1', 'gazole', 1.699),
    reading('2', 'gazole', 1.729),
    reading('1', 'sp98', 1.879),
    reading('2', 'sp98', 1.859),
  ];
  await pass(events, first);
  sent.length = 0;
  // Only the SP98 leader changes.
  await pass(events, [
    reading('1', 'gazole', 1.699),
    reading('2', 'gazole', 1.729),
    reading('1', 'sp98', 1.799),
    reading('2', 'sp98', 1.859),
  ]);

  const changes = sent.filter((e) => e.key === SCENE_TRIGGERS.CHEAPEST_STATION_CHANGED);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].data.fuel, 'sp98');
});

test('the feed status is a transition, fired once — not a state repeated hourly', async () => {
  const { sent, publish } = recorder();
  const events = createSceneEvents({}, { publish });

  // A healthy start says nothing: nothing changed.
  await pass(events, [reading('1', 'gazole', 1.699)]);
  assert.deepEqual(sent, []);

  await pass(events, [], { failed: true, error: new Error('fetch failed (ECONNREFUSED)') });
  await pass(events, [], { failed: true, error: new Error('fetch failed (ECONNREFUSED)') });
  const down = sent.filter((e) => e.key === SCENE_TRIGGERS.FEED_STATUS_CHANGED);
  assert.equal(down.length, 1, 'the second failed pass changes nothing');
  assert.equal(down[0].data.status, FEED_STATUSES.UNAVAILABLE);
  assert.equal(down[0].data.error, 'fetch failed (ECONNREFUSED)');

  sent.length = 0;
  await pass(events, [reading('1', 'gazole', 1.699)], {
    lastSuccessAt: Date.parse('2026-08-06T07:12:00'),
  });
  const up = sent.filter((e) => e.key === SCENE_TRIGGERS.FEED_STATUS_CHANGED);
  assert.equal(up.length, 1);
  assert.equal(up[0].data.status, FEED_STATUSES.AVAILABLE);
  assert.equal(up[0].data.error, '');
  assert.equal(up[0].data.last_success, '06/08/2026 à 07:12');
});

test('an error message too long for a scene event is cut down', async () => {
  const { sent, publish } = recorder();
  const events = createSceneEvents({}, { publish });

  await pass(events, [reading('1', 'gazole', 1.699)]);
  await pass(events, [], { failed: true, error: new Error('x'.repeat(5000)) });

  const [event] = sent.filter((e) => e.key === SCENE_TRIGGERS.FEED_STATUS_CHANGED);
  assert.ok(event.data.error.length <= 200, 'the host API refuses more than 1000 characters');
});

test('a Gladys that does not know scene triggers is asked exactly once', async () => {
  const notFound = Object.assign(new Error('Not found'), { status: 404 });
  const { sent, publish } = recorder(() => {
    throw notFound;
  });
  const events = createSceneEvents({}, { publish });

  await pass(events, [reading('1', 'gazole', 1.722)]);
  await pass(events, [reading('1', 'gazole', 1.699)]);
  await pass(events, [reading('1', 'gazole', 1.679)]);

  assert.equal(sent.length, 1, 'the first 404 disables the publisher');
  assert.equal(events.enabled, false);
});

test('a delivery that failed is not replayed on the next pass', async () => {
  let fail = true;
  const { sent, publish } = recorder(() => {
    if (fail) {
      // Not a 404: a rate limit, a core restarting… the publisher stays on.
      throw Object.assign(new Error('Too many requests'), { status: 429 });
    }
  });
  const events = createSceneEvents({}, { publish });

  await pass(events, [reading('1', 'gazole', 1.722)]);
  await pass(events, [reading('1', 'gazole', 1.699)]);
  fail = false;
  await pass(events, [reading('1', 'gazole', 1.699)]);

  assert.equal(sent.length, 1, 'the lost transition is lost, never repeated');
  assert.equal(events.enabled, true);
});

test('reset() drops the baselines the new configuration invalidated', async () => {
  const { sent, publish } = recorder();
  const events = createSceneEvents({}, { publish });

  await pass(events, [reading('1', 'gazole', 1.722)]);
  events.reset();
  await pass(events, [reading('1', 'gazole', 1.699)]);

  assert.deepEqual(sent, [], 'after a reset the next pass is a first pass again');
});

test('a station read with no price is not a reading at all', async () => {
  const { sent, publish } = recorder();
  const events = createSceneEvents({}, { publish });

  await pass(events, [reading('1', 'gazole', 1.699)]);
  await pass(events, [reading('1', 'gazole', null)]);
  await pass(events, [reading('1', 'gazole', 1.699)]);

  assert.deepEqual(sent, [], 'a missing price is a hole, not a change');
});

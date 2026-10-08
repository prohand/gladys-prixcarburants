// Device states go to Gladys in batches of at most 100, and a 429 is waited
// out once: the host API takes 300 states a minute per integration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_STATES_PER_REQUEST,
  RATE_LIMIT_WAIT_MS,
  featureState,
  publishStates,
} from '../src/statePublisher.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const states = (count) => Array.from({ length: count }, (_, i) => featureState(`f${i}`, i));

/** A GladysApiError as the SDK throws it: a status, no headers. */
const apiError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

test('a state is a numeric `state` or a `text`, never both', () => {
  assert.deepEqual(featureState('a', 1.699), { device_feature_external_id: 'a', state: 1.699 });
  assert.deepEqual(featureState('b', { text: 'auj.' }), {
    device_feature_external_id: 'b',
    text: 'auj.',
  });
});

test('states are sent in chunks of at most 100', async () => {
  const gladys = createFakeGladys();
  const sent = await publishStates(gladys, states(250));
  assert.equal(sent, 250);
  assert.deepEqual(gladys.stateRequests, [100, 100, 50]);
  assert.equal(MAX_STATES_PER_REQUEST, 100);
});

test('nothing to publish costs no request', async () => {
  const gladys = createFakeGladys();
  await publishStates(gladys, []);
  assert.deepEqual(gladys.stateRequests, []);
});

test('a 429 is waited out once, then the same chunk is sent again', async () => {
  const gladys = createFakeGladys();
  const send = gladys.publishStates;
  let refused = 0;
  gladys.publishStates = async (chunk) => {
    if (refused === 0) {
      refused += 1;
      throw apiError(429);
    }
    return send(chunk);
  };
  const waits = [];

  await publishStates(gladys, states(3), { sleep: async (ms) => waits.push(ms) });

  assert.deepEqual(waits, [RATE_LIMIT_WAIT_MS]);
  assert.deepEqual(gladys.stateRequests, [3], 'the refused chunk got through on the retry');
  assert.ok(RATE_LIMIT_WAIT_MS <= 60_000, 'never longer than the window of the limit');
});

test('a second 429 propagates, and so does any other refusal, unretried', async () => {
  const always = (status) => {
    let calls = 0;
    const gladys = {
      async publishStates() {
        calls += 1;
        throw apiError(status);
      },
    };
    return { gladys, calls: () => calls };
  };

  const limited = always(429);
  await assert.rejects(publishStates(limited.gladys, states(1), { sleep: async () => {} }), {
    status: 429,
  });
  assert.equal(limited.calls(), 2);

  const refused = always(422);
  await assert.rejects(publishStates(refused.gladys, states(1), { sleep: async () => {} }), {
    status: 422,
  });
  assert.equal(refused.calls(), 1);
});

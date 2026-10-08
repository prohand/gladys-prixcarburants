// The `connected` handler: whatever the host API answers during a
// (re)connection, the refresh timer ends up armed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnectedHandler } from '../src/lifecycle.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const apiError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

/** Every dependency of the handler, recording what happened in which order. */
function harness(overrides = {}) {
  const gladys = createFakeGladys();
  const steps = [];
  let config = { poll_frequency: 3600, from: 'previous' };
  const deps = {
    gladys,
    readConfig: async () => {
      steps.push('readConfig');
      config = { poll_frequency: 600, from: 'gladys' };
      return config;
    },
    currentConfig: () => config,
    refreshLoop: {
      armedWith: [],
      start(cfg) {
        steps.push('start');
        this.armedWith.push(cfg);
      },
      async runNow() {
        steps.push('runNow');
      },
    },
    priceHistory: { load: async () => steps.push('load') },
    syncTrackedStations: async () => steps.push('sync'),
    runDiscovery: async () => steps.push('discovery'),
    ...overrides,
  };
  return { deps, steps, gladys, onConnected: createConnectedHandler(deps) };
}

test('a healthy (re)connection arms the loop before talking to anything else', async () => {
  const { deps, steps, gladys, onConnected } = harness();

  await onConnected();

  assert.deepEqual(steps, ['readConfig', 'start', 'load', 'sync', 'discovery', 'runNow']);
  assert.deepEqual(deps.refreshLoop.armedWith, [{ poll_frequency: 600, from: 'gladys' }]);
  assert.deepEqual(gladys.connectionStatuses, [{ connected: true, message: undefined }]);
});

test('a 429 on the device list after the config still leaves the timer armed', async () => {
  const { deps, gladys, onConnected } = harness({
    syncTrackedStations: async () => {
      throw apiError(429);
    },
  });

  await onConnected(); // never rejects

  assert.equal(deps.refreshLoop.armedWith.length, 1, 'armed once, before the failure');
  assert.equal(gladys.connectionStatuses[0].connected, false);
});

test('a config that cannot be read arms the loop with the one in force', async () => {
  const { deps, gladys, onConnected } = harness({
    readConfig: async () => {
      throw apiError(503);
    },
  });

  await onConnected();

  assert.deepEqual(deps.refreshLoop.armedWith, [{ poll_frequency: 3600, from: 'previous' }]);
  assert.equal(gladys.connectionStatuses[0].connected, false);
});

test('a failed discovery costs the Discovery tab, not the first refresh', async () => {
  const { steps, gladys, onConnected } = harness({
    runDiscovery: async () => {
      throw apiError(500);
    },
  });

  await onConnected();

  assert.ok(steps.includes('runNow'));
  assert.equal(gladys.connectionStatuses[0].connected, true);
});

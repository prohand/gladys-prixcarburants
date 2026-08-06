// -----------------------------------------------------------------------------
// Entry point of the "Fuel prices" Gladys external integration.
//
// Role of this file: wire the SDK to the rest of the code. It holds no business
// logic — searching stations lives in src/countries/, building devices in
// src/devices/, caching in src/stationStore.js, refreshing in src/refresh.js.
// This file only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. connects, then publishes the stations found around the postal code.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { isConfigReady, normalizeConfig } from './src/config.js';
import { createStationStore } from './src/stationStore.js';
import { parseTargets, pollDevice, publishDiscovery } from './src/devices/index.js';
import { createRefreshLoop } from './src/refresh.js';
import { ACTIONS } from './src/actions.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// Shared cache + batching in front of the open data providers, so ten station
// devices polling one after the other cost one HTTP request, not ten.
const store = createStationStore();

// The prices are refreshed by our own timer: Gladys' `poll_frequency` tops out
// at one minute, which says nothing useful about a feed updated every ~10 min.
// See src/refresh.js.
const refreshLoop = createRefreshLoop(gladys, { store });

// --- Discovery: Gladys asks for the list of devices --------------------------
// The user opens the Discovery tab: search the stations around the configured
// postal code and publish one device per (station, fuel). Adding and removing
// them is then plain Gladys: add from Discovery, delete from the device page.
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> searching stations');
  // A scan handler has no ack: the SDK swallows whatever it throws, and the
  // Discovery tab would just stay empty without a word. Log it ourselves.
  try {
    await runDiscovery();
  } catch (err) {
    logger.error('Discovery failed, the Discovery tab will stay empty', err);
    throw err;
  }
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// The devices declare no `poll_frequency` (see src/refresh.js), so Gladys does
// not poll them — refreshing is our timer's job. The handler stays registered
// because answering "not implemented" to a poll Gladys does decide to send
// would be a lie: reading one device on demand costs nothing.
gladys.onPoll(async (device) => {
  await pollDevice(gladys, { device, config, store });
});

// --- The user added a station from the Discovery tab -------------------------
// Track it right away and publish a first price, so the device is not empty
// until the first poll fires.
gladys.onDeviceCreated(async (device) => {
  const [target] = parseTargets([device]);
  if (!target) {
    return;
  }
  logger.info(`Station added: ${device.name} (${target.fuel})`);
  store.track(target.country, target.stationId);
  try {
    await pollDevice(gladys, { device, config, store });
  } catch (err) {
    logger.error(`First read failed for ${device.external_id}`, err);
  }
});

// --- The user deleted a station ----------------------------------------------
// Recompute the tracked set from what Gladys still holds: several devices can
// share one station (one per fuel), so deleting one of them must not stop
// refreshing the others.
gladys.onDeviceDeleted(async (device) => {
  const [target] = parseTargets([device]);
  if (!target) {
    return;
  }
  logger.info(`Station removed: ${device.name} (${target.fuel})`);
  await syncTrackedStations();
});

// --- Manifest actions: buttons in the Configuration screen -------------------
for (const [actionKey, handler] of Object.entries(ACTIONS)) {
  gladys.onAction(actionKey, () => handler(gladys, { config, store }));
}

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  // The postal code, the radius or the fuel list may all have changed: drop the
  // cached stations and republish a discovery list built from the new criteria.
  store.invalidate();
  // The refresh interval may have changed too: re-arm the loop so the value the
  // user just saved applies without waiting for the next tick.
  refreshLoop.start(config);
  await runDiscovery();
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK logs the WebSocket lifecycle itself (under the `gladys-sdk` name);
// this handler only runs the integration's own (re)initialization.
gladys.on('connected', async () => {
  try {
    // 1) Fetch the config filled in by the user.
    config = normalizeConfig(await gladys.getConfig());

    // 2) Remember which stations already have a device, so the very first
    //    refresh batches them all in one request.
    await syncTrackedStations();

    // 3) Publish the discovery list (and re-publish the created devices).
    await runDiscovery();

    // 4) Arm our own refresh timer and publish a first round of prices right
    //    away, so a restarted container does not leave the dashboard waiting a
    //    full interval.
    refreshLoop.start(config);
    await refreshLoop.runNow(config);

    // 5) Report the application-level status, shown in the Configuration
    //    screen. Distinct from the container state: the integration can be
    //    RUNNING and still unable to reach the open data API.
    await gladys.setConnectionStatus(true);
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

// Stop refreshing while Gladys is unreachable: the SDK reconnects on its own
// and the `connected` handler re-arms the loop.
gladys.on('disconnected', () => {
  refreshLoop.stop();
});

/**
 * Search the stations and publish them to the Discovery tab, alongside the
 * devices the user already created.
 */
async function runDiscovery() {
  if (!isConfigReady(config)) {
    logger.warn('No postal code configured yet: nothing to discover');
    return;
  }
  const createdDevices = await gladys.getDevices();
  await publishDiscovery(gladys, { config, store, createdDevices });
}

/** Align the store's tracked stations with the devices Gladys holds. */
async function syncTrackedStations() {
  const devices = await gladys.getDevices();
  const targets = parseTargets(devices);
  store.setTracked(targets);
  logger.info(`${targets.length} station device(s) tracked`);
}

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  refreshLoop.stop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the fuel prices integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});

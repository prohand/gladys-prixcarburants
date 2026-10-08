// -----------------------------------------------------------------------------
// What the integration does every time the WebSocket (re)connects.
//
// Lives here rather than in index.js for one reason: its ORDER is a contract,
// and index.js cannot be imported by a test (it connects on import). The
// contract is that the refresh timers are armed whatever happens next. Every
// step of the (re)initialization talks to the host API — the config, the
// device list, the discovery payload — and a reconnection is exactly when the
// core answers 429 or 5xx (it is restarting, or every integration reconnects
// at once). A failure there used to jump straight to the catch with the loop
// still disarmed: `disconnected` had stopped it, and nothing refreshed a
// single price until the NEXT reconnection.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'lifecycle' });

/**
 * Build the `connected` handler.
 *
 * @param {{
 *   gladys: object,
 *   readConfig: () => Promise<object>,
 *   currentConfig: () => object,
 *   refreshLoop: { start: Function, runNow: Function },
 *   priceHistory: { load: Function },
 *   syncTrackedStations: () => Promise<void>,
 *   runDiscovery: () => Promise<void>,
 * }} deps
 *   `readConfig` fetches, normalizes and stores the configuration;
 *   `currentConfig` returns the one in force — the previous one when the fetch
 *   failed, which is still the best schedule there is.
 * @returns {() => Promise<void>} never rejects
 */
export function createConnectedHandler({
  gladys,
  readConfig,
  currentConfig,
  refreshLoop,
  priceHistory,
  syncTrackedStations,
  runDiscovery,
}) {
  return async function onConnected() {
    let armed = false;
    const arm = () => {
      refreshLoop.start(currentConfig());
      armed = true;
    };

    try {
      // 1) The config filled in by the user: it holds the refresh interval.
      await readConfig();

      // 2) Arm our own refresh timer BEFORE anything else reaches Gladys or the
      //    open data API, so no failure below can leave the integration with
      //    no timer. Arming does not tick: the first scheduled pass is one
      //    interval away, and step 6 runs one right now.
      arm();

      // 3) Reload the price history of the previous run, so a restart does not
      //    reset the curve of the dashboard to a single point.
      await priceHistory.load();

      // 4) Remember which stations already have a device, so the very first
      //    refresh batches them all in one request.
      await syncTrackedStations();

      // 5) Publish the discovery list (and re-publish the created devices). A
      //    failure here only costs the Discovery tab until the next scan: the
      //    devices already created keep being refreshed by the loop.
      try {
        await runDiscovery();
      } catch (err) {
        logger.error('Discovery failed, the created devices keep refreshing', err);
      }

      // 6) Publish a first round of prices right away, so a restarted container
      //    does not leave the dashboard waiting a full interval.
      await refreshLoop.runNow(currentConfig());

      // 7) Report the application-level status, shown in the Configuration
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
    } finally {
      // The config itself could not be read (a 429 right after a reconnect):
      // the previous one still says how often to refresh. A dead timer is the
      // one outcome this handler must never leave behind.
      if (!armed) {
        try {
          arm();
        } catch (err) {
          logger.error('Refresh loop not armed', err);
        }
      }
    }
  };
}

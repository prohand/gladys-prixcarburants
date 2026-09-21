// -----------------------------------------------------------------------------
// Price refresh loop.
//
// Why the integration schedules its own refresh instead of letting Gladys poll:
// a Gladys device declares its polling with `poll_frequency`, an ENUM of
// millisecond values capped at ONE MINUTE (1s, 2s, 10s, 15s, 30s, 60s). That
// range is sized for a plug or a lamp, not for a national open data feed
// refreshed every ~10 minutes — and the manifest lets the user ask for anything
// between 10 minutes and 24 hours. Publishing a value outside the enum makes
// Gladys reject the ENTIRE discovery payload, so the devices carry no
// `poll_frequency` at all (see src/devices/fuelStation.js) and this module owns
// the schedule.
//
// One tick = one pass over every station device, served by the station store:
// ten devices sharing one country cost ONE HTTP request, not ten.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { parseTargets, pollDevice, publishIntegrationState } from './devices/index.js';
import { notifyWidgetsChanged } from './widgets/index.js';
import { isConfigReady } from './config.js';

const logger = createLogger({ name: 'refresh' });

/**
 * Keep the widget curve filling when nobody is looking at the dashboard.
 *
 * The widget samples the cheapest price of the area on every pull, but the core
 * only pulls while a dashboard shows the card: a card nobody opens for a week
 * would have a week-long hole. So the refresh loop samples too — but ONLY for
 * an area the history already follows (`knows`), which means a card exists
 * somewhere, and only when the last sample is old enough to deserve a new one.
 * An install with no widget therefore pays nothing.
 *
 * Best effort by construction: a failed search leaves the curve as it was.
 *
 * @param {{ config: object, store: object, history?: object }} context
 */
async function sampleForWidgets({ config, store, history }) {
  if (!history || !isConfigReady(config) || !history.knows(config)) {
    return;
  }
  const last = history.lastSampleAt(config);
  if (last !== null && Date.now() - last < history.sampleIntervalMs) {
    return;
  }
  try {
    history.record(config, await store.search(config));
  } catch (err) {
    logger.debug(`Widget sampling skipped: ${err.message}`);
  }
}

/**
 * Read every station device Gladys holds and publish its current price.
 *
 * A device that fails is counted and logged, never thrown: one station missing
 * from the feed must not stop the nine others from being refreshed.
 *
 * @param {object} gladys SDK instance
 * @param {{ config: object, store: object, history?: object, force?: boolean,
 *   sceneEvents?: object }} context
 *   `force` drops the cached stations first, so the pass really hits the
 *   provider — what the "Refresh the prices now" button means. The periodic
 *   loop leaves it off: its interval (10 min minimum) is always longer than the
 *   store TTL anyway, and a refresh right after a reconnection then costs
 *   nothing.
 *   `sceneEvents` is optional: without it the pass behaves exactly as before,
 *   which is what keeps a Gladys that ignores scene triggers unaffected.
 * @returns {Promise<{ total: number, updated: number, failures: string[] }>}
 */
export async function refreshAllDevices(
  gladys,
  { config, store, history, force = false, sceneEvents = null },
) {
  const devices = await gladys.getDevices();
  const targets = parseTargets(devices);
  if (targets.length === 0) {
    // Still worth a status publish: the user may hold the integration device
    // alone, and a previous search already dated the last read of the feed.
    await publishIntegrationState(gladys, { store, devices });
    // A user may hold no station device and still have the widget on a
    // dashboard: the curve is worth keeping alive for them too.
    await sampleForWidgets({ config, store, history });
    return { total: 0, updated: 0, failures: [] };
  }

  // Align the tracked set with what Gladys holds BEFORE reading anything: the
  // first `getStation` then batches every station of the country in one
  // request instead of discovering them one device at a time.
  store.setTracked(targets);

  if (force) {
    store.invalidate();
  }

  let updated = 0;
  const failures = [];
  // What changed since the previous pass is a property of the PASS, not of a
  // device: "the cheapest station you follow is no longer the same one" can
  // only be answered once every station has been read. See src/sceneEvents.js.
  const pass = sceneEvents?.startPass() ?? null;
  let lastError = null;
  for (const target of targets) {
    const { device } = target;
    try {
      const { price, station } = await pollDevice(gladys, { device, config, store });
      if (price !== null) {
        updated += 1;
        pass?.record({ device, target, station, price });
      }
    } catch (err) {
      logger.error(`Refresh failed for ${device.external_id}`, err);
      failures.push(device.name ?? device.external_id);
      lastError = err;
    }
  }

  // Last, so it reports the read this very pass just did. A pass where every
  // station failed leaves `store.lastFetchAt` where it was: the date then ages
  // on the dashboard, which is precisely the signal.
  await publishIntegrationState(gladys, { store, devices });

  await sampleForWidgets({ config, store, history });

  // Nudge the dashboard cards: their content is cached by the core for their
  // TTL, and a pass that moved a price is exactly the moment that cache should
  // be dropped. Fire-and-forget, rate-limited core-side, no data attached.
  if (updated > 0) {
    notifyWidgetsChanged(gladys);
  }

  // Last of all, and never fatal: a scene trigger that cannot be delivered must
  // not turn a successful refresh into a failed one (the core may simply not
  // know about scene triggers yet).
  if (pass) {
    try {
      await pass.end({
        // Every station failing is the feed being unreachable; one station
        // missing from it is just one station missing from it.
        failed: failures.length === targets.length,
        error: lastError,
        lastSuccessAt: store.lastFetchAt,
      });
    } catch (err) {
      logger.error('Scene events of this pass were not published', err);
    }
  }

  return { total: targets.length, updated, failures };
}

/**
 * The periodic refresh, as a startable/stoppable object so `index.js` stays
 * declarative and the tests can drive the clock instead of waiting an hour.
 *
 * @param {object} gladys SDK instance
 * @param {{ store: object, history?: object, sceneEvents?: object,
 *   setTimer?: Function, clearTimer?: Function }} context
 *   `setTimer`/`clearTimer` are the seam the unit tests use in place of
 *   `setInterval`/`clearInterval`.
 */
export function createRefreshLoop(
  gladys,
  { store, history, sceneEvents = null, setTimer = setInterval, clearTimer = clearInterval },
) {
  let timer = null;
  let running = false;

  /** One tick, never overlapping with the previous one. */
  async function tick(config) {
    if (running) {
      // The previous pass is still waiting on the open data API: skipping is
      // the right answer, queueing would only pile requests up.
      logger.warn('Previous refresh still running, skipping this tick');
      return;
    }
    running = true;
    try {
      const { total, updated, failures } = await refreshAllDevices(gladys, {
        config,
        store,
        history,
        sceneEvents,
      });
      if (total > 0) {
        logger.info(
          `Periodic refresh: ${updated}/${total} price(s) updated` +
            (failures.length > 0 ? ` (${failures.length} failed)` : ''),
        );
      }
    } catch (err) {
      // Never let a rejection escape a timer callback: it would take the
      // container down on an unhandled rejection.
      logger.error('Periodic refresh failed', err);
    } finally {
      running = false;
    }
  }

  return {
    /**
     * (Re)arm the loop with the current configuration. Calling it again — after
     * a configuration change or a reconnection — replaces the previous timer,
     * so the interval the user just saved applies immediately.
     * @param {object} config normalized configuration
     */
    start(config) {
      this.stop();
      const intervalMs = config.poll_frequency * 1000;
      timer = setTimer(() => tick(config), intervalMs);
      // Do not hold the event loop open just for the refresh timer.
      timer?.unref?.();
      logger.info(`Prices will be refreshed every ${config.poll_frequency}s`);
    },

    /** Disarm the loop (shutdown, lost connection). */
    stop() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },

    /** Run one pass right now, outside the schedule. */
    async runNow(config) {
      await tick(config);
    },
  };
}

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

const logger = createLogger({ name: 'refresh' });

/**
 * Read every station device Gladys holds and publish its current price.
 *
 * A device that fails is counted and logged, never thrown: one station missing
 * from the feed must not stop the nine others from being refreshed.
 *
 * @param {object} gladys SDK instance
 * @param {{ config: object, store: object, force?: boolean }} context
 *   `force` drops the cached stations first, so the pass really hits the
 *   provider — what the "Refresh the prices now" button means. The periodic
 *   loop leaves it off: its interval (10 min minimum) is always longer than the
 *   store TTL anyway, and a refresh right after a reconnection then costs
 *   nothing.
 * @returns {Promise<{ total: number, updated: number, failures: string[] }>}
 */
export async function refreshAllDevices(gladys, { config, store, force = false }) {
  const devices = await gladys.getDevices();
  const targets = parseTargets(devices);
  if (targets.length === 0) {
    // Still worth a status publish: the user may hold the integration device
    // alone, and a previous search already dated the last read of the feed.
    await publishIntegrationState(gladys, { store, devices });
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
  for (const { device } of targets) {
    try {
      const { price } = await pollDevice(gladys, { device, config, store });
      if (price !== null) {
        updated += 1;
      }
    } catch (err) {
      logger.error(`Refresh failed for ${device.external_id}`, err);
      failures.push(device.name ?? device.external_id);
    }
  }

  // Last, so it reports the read this very pass just did. A pass where every
  // station failed leaves `store.lastFetchAt` where it was: the date then ages
  // on the dashboard, which is precisely the signal.
  await publishIntegrationState(gladys, { store, devices });

  return { total: targets.length, updated, failures };
}

/**
 * The periodic refresh, as a startable/stoppable object so `index.js` stays
 * declarative and the tests can drive the clock instead of waiting an hour.
 *
 * @param {object} gladys SDK instance
 * @param {{ store: object, setTimer?: Function, clearTimer?: Function }} context
 *   `setTimer`/`clearTimer` are the seam the unit tests use in place of
 *   `setInterval`/`clearInterval`.
 */
export function createRefreshLoop(
  gladys,
  { store, setTimer = setInterval, clearTimer = clearInterval },
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
      const { total, updated, failures } = await refreshAllDevices(gladys, { config, store });
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

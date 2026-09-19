// -----------------------------------------------------------------------------
// Price history: the 30-day curve and the 7-day trend of the widgets.
//
// Why it exists at all. Gladys keeps the history of the devices the user added,
// but the "cheapest around me" card follows something no device holds: the
// LOWEST price of the area, whichever station is cheapest today. Nobody stores
// that — and the French open data feed publishes the prices of the moment, not
// yesterday's. So the integration samples it itself: every time a search runs
// (a widget pull, a discovery, the "Preview" button), the cheapest price of
// each fuel is recorded, at most one sample per hour.
//
// Deliberately BEST EFFORT, which is what makes it compatible with the
// "no state to survive a restart" rule the rest of the code follows: the file
// lives in `/data` (the only writable volume of the Gladys sandbox), and every
// failure to read or write it is a debug line, never an error. An empty history
// simply means the card shows no curve and no trend yet — everything else works
// exactly the same.
//
// The series is keyed by what defines the area: country, postal code, radius
// and fuel. Moving the postal code therefore starts a new curve instead of
// gluing two unrelated ones together.
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'price-history' });

/** The only writable volume of the sandbox. */
const DEFAULT_FILE = '/data/price-history.json';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long a point is kept, and how often one is taken. */
const RETENTION_DAYS = 30;
const SAMPLE_INTERVAL_MS = HOUR_MS;

/** Debounce of the save: a burst of samples costs one write. */
const SAVE_DELAY_MS = 5_000;

/**
 * The series key of one (area, fuel) pair.
 * @param {{ country: string, postal_code: string, search_radius_km: number }} config
 * @param {string} fuel
 */
export function seriesKey(config, fuel) {
  return `${config.country}:${config.postal_code}:${config.search_radius_km}:${fuel}`;
}

/**
 * @param {{ file?: string, now?: () => number, retentionDays?: number }} [options]
 *   `file` and `now` are the seams the tests use instead of a real /data and a
 *   real clock.
 */
export function createPriceHistory({
  file = DEFAULT_FILE,
  now = Date.now,
  retentionDays = RETENTION_DAYS,
} = {}) {
  /** @type {Map<string, Array<{ t: number, v: number }>>} key -> samples, oldest first */
  const series = new Map();
  let saveTimer = null;
  let loaded = false;

  /** Drop everything older than the retention window. */
  function prune() {
    const floor = now() - retentionDays * DAY_MS;
    for (const [key, points] of series) {
      const kept = points.filter((point) => point.t >= floor);
      if (kept.length === 0) {
        series.delete(key);
      } else if (kept.length !== points.length) {
        series.set(key, kept);
      }
    }
  }

  /** Read the file written by a previous run. Missing or corrupt: start empty. */
  async function load() {
    if (loaded) {
      return;
    }
    loaded = true;
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      for (const [key, points] of Object.entries(raw?.series ?? {})) {
        if (!Array.isArray(points)) {
          continue;
        }
        const clean = points
          .filter((point) => Number.isFinite(point?.t) && Number.isFinite(point?.v))
          .map((point) => ({ t: point.t, v: point.v }))
          .sort((a, b) => a.t - b.t);
        if (clean.length > 0) {
          series.set(key, clean);
        }
      }
      prune();
      logger.info(`Price history loaded: ${series.size} series`);
    } catch (err) {
      // ENOENT on the first run, EACCES on a read-only volume, a truncated file
      // after a power cut: none of them is worth an error line.
      logger.debug(`No price history loaded (${err.code ?? err.message})`);
    }
  }

  /** Write the file, atomically, so a restart never reads half a JSON. */
  async function save() {
    const payload = { version: 1, series: Object.fromEntries(series) };
    const temporary = `${file}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(temporary, JSON.stringify(payload), 'utf8');
      await rename(temporary, file);
    } catch (err) {
      logger.debug(`Price history not saved (${err.code ?? err.message})`);
    }
  }

  function scheduleSave() {
    if (saveTimer !== null) {
      return;
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save();
    }, SAVE_DELAY_MS);
    // Never hold the event loop open just to flush a cache.
    saveTimer?.unref?.();
  }

  return {
    load,

    /**
     * Record the cheapest price of every fuel of a search result.
     *
     * One sample per hour and per series: a dashboard refreshing every ten
     * minutes does not turn into 144 points a day.
     *
     * @param {object} config normalized configuration (defines the area)
     * @param {Array<{ prices: Record<string, number|null> }>} stations
     */
    record(config, stations) {
      const at = now();
      const cheapest = new Map();
      for (const station of stations) {
        for (const [fuel, price] of Object.entries(station.prices ?? {})) {
          if (!Number.isFinite(price)) {
            continue;
          }
          const key = seriesKey(config, fuel);
          if (!(cheapest.get(key) <= price)) {
            cheapest.set(key, price);
          }
        }
      }

      let changed = false;
      for (const [key, price] of cheapest) {
        const points = series.get(key) ?? [];
        const last = points[points.length - 1];
        if (last && at - last.t < SAMPLE_INTERVAL_MS) {
          continue;
        }
        points.push({ t: at, v: price });
        series.set(key, points);
        changed = true;
      }

      if (changed) {
        prune();
        scheduleSave();
      }
    },

    /**
     * The daily curve of a series, ready for a `chart` component: one point per
     * day, the cheapest price seen that day, oldest first.
     *
     * Daily rather than hourly on purpose — a fuel price moves a few times a
     * week, so 30 points draw the same curve as 720 and keep the payload small.
     *
     * @param {object} config
     * @param {string} fuel
     * @returns {Array<{ t: string, v: number }>} ISO dates, as the core expects
     */
    dailySeries(config, fuel) {
      const points = series.get(seriesKey(config, fuel)) ?? [];
      const perDay = new Map();
      for (const { t, v } of points) {
        const day = new Date(t).toISOString().slice(0, 10);
        if (!(perDay.get(day)?.v <= v)) {
          perDay.set(day, { t, v });
        }
      }
      return [...perDay.values()]
        .sort((a, b) => a.t - b.t)
        .map(({ t, v }) => ({ t: new Date(t).toISOString(), v }));
    },

    /**
     * How much the cheapest price moved over the last `days` days.
     *
     * @param {object} config
     * @param {string} fuel
     * @param {number} [days]
     * @returns {number|null} the difference in EUR/L (negative = cheaper than
     *   before), or `null` when the history does not go back far enough — the
     *   tile is then simply not shown, rather than showing a made-up zero
     */
    trend(config, fuel, days = 7) {
      const points = series.get(seriesKey(config, fuel)) ?? [];
      if (points.length < 2) {
        return null;
      }
      const target = now() - days * DAY_MS;
      // The oldest point still counts as "a week ago" only if it really is old
      // enough; a history started yesterday says nothing about last week.
      const past = [...points].reverse().find((point) => point.t <= target);
      if (!past) {
        return null;
      }
      return points[points.length - 1].v - past.v;
    },

    /** Flush now — used by the tests and on shutdown. */
    flush() {
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      return save();
    },

    /** How many series are held, for the logs and the tests. */
    get size() {
      return series.size;
    },
  };
}

/** Default file path, exported so index.js can log where the history lives. */
export const PRICE_HISTORY_FILE = DEFAULT_FILE;

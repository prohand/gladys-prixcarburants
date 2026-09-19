// -----------------------------------------------------------------------------
// Price history.
//
// What matters here is what the widgets read back: one sample an hour, a daily
// curve, a trend that says nothing rather than something false when the history
// is too young, and a file that never breaks the integration when `/data` is
// not writable.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPriceHistory, seriesKey } from '../src/priceHistory.js';
import { normalizeConfig } from '../src/config.js';
import { createStation } from './helpers/fakeGladys.js';

const config = normalizeConfig({ postal_code: '35000', search_radius_km: 10 });

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A history driven by a clock the test moves itself. */
function historyAt(start, file = join(tmpdir(), 'never-written.json')) {
  let clock = start;
  const history = createPriceHistory({ file, now: () => clock });
  return { history, advance: (ms) => (clock += ms) };
}

const stationsAt = (...prices) =>
  prices.map((price, index) =>
    createStation({
      id: String(index),
      // SP95 a round ten centimes above the diesel, written out rather than
      // computed: 1.699 + 0.1 is 1.7990000000000002 in binary floating point.
      prices: { gazole: price, sp95: Number((price + 0.1).toFixed(3)) },
    }),
  );

test('the series key changes with the area, so moving the postal code starts a new curve', () => {
  const elsewhere = normalizeConfig({ postal_code: '44000', search_radius_km: 10 });
  assert.notEqual(seriesKey(config, 'gazole'), seriesKey(elsewhere, 'gazole'));
  assert.notEqual(seriesKey(config, 'gazole'), seriesKey(config, 'sp95'));
});

test('only the cheapest price of the area is recorded, per fuel', () => {
  const { history } = historyAt(Date.UTC(2026, 8, 19, 10));

  history.record(config, stationsAt(1.799, 1.699, 1.749));

  assert.deepEqual(
    history.dailySeries(config, 'gazole').map((point) => point.v),
    [1.699],
  );
  assert.deepEqual(
    history.dailySeries(config, 'sp95').map((point) => point.v),
    [1.799],
  );
});

test('a dashboard refreshing every ten minutes still records one point an hour', () => {
  const { history, advance } = historyAt(Date.UTC(2026, 8, 19, 10));

  history.record(config, stationsAt(1.7));
  advance(10 * 60 * 1000);
  history.record(config, stationsAt(1.6));
  advance(10 * 60 * 1000);
  history.record(config, stationsAt(1.5));

  assert.equal(history.dailySeries(config, 'gazole').length, 1);
});

test('the daily curve keeps the cheapest price of each day, oldest first', () => {
  const { history, advance } = historyAt(Date.UTC(2026, 8, 1, 6));

  history.record(config, stationsAt(1.8));
  advance(6 * HOUR);
  history.record(config, stationsAt(1.75)); // same day, cheaper
  advance(DAY);
  history.record(config, stationsAt(1.9));

  const points = history.dailySeries(config, 'gazole');
  assert.deepEqual(
    points.map((point) => point.v),
    [1.75, 1.9],
  );
  assert.ok(points[0].t < points[1].t, 'ISO dates, oldest first');
});

test('the trend says nothing until the history covers the window', () => {
  const { history, advance } = historyAt(Date.UTC(2026, 8, 1));

  history.record(config, stationsAt(1.8));
  assert.equal(history.trend(config, 'gazole', 7), null, 'one point is not a trend');

  advance(2 * DAY);
  history.record(config, stationsAt(1.7));
  assert.equal(history.trend(config, 'gazole', 7), null, 'two days do not make a week');

  advance(6 * DAY);
  history.record(config, stationsAt(1.75));
  const trend = history.trend(config, 'gazole', 7);
  assert.ok(trend !== null, 'the window is now covered');
  assert.ok(Math.abs(trend - -0.05) < 1e-9, '1.75 today against 1.80 eight days ago');
});

test('points older than the retention window are dropped', () => {
  const { history, advance } = historyAt(Date.UTC(2026, 1, 1));

  history.record(config, stationsAt(1.5));
  advance(40 * DAY);
  history.record(config, stationsAt(1.6));

  assert.deepEqual(
    history.dailySeries(config, 'gazole').map((point) => point.v),
    [1.6],
  );
});

test('the history survives a restart through the file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fuel-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'nested', 'price-history.json');

  const first = historyAt(Date.UTC(2026, 8, 1), file);
  first.history.record(config, stationsAt(1.65));
  await first.history.flush();

  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(written.version, 1);

  const second = historyAt(Date.UTC(2026, 8, 2), file);
  await second.history.load();
  assert.deepEqual(
    second.history.dailySeries(config, 'gazole').map((point) => point.v),
    [1.65],
  );
});

test('an unreadable or unwritable /data costs the curve, never the integration', async () => {
  // A path under a regular FILE: every read and every mkdir fails with
  // ENOTDIR, which no permission on the test machine can turn into a success.
  const { history } = historyAt(Date.now(), '/etc/hostname/price-history.json');

  await assert.doesNotReject(() => history.load());
  assert.equal(history.size, 0);
  history.record(config, stationsAt(1.7));
  await assert.doesNotReject(() => history.flush());
  // The samples still live in memory: the card works, only the restart forgets.
  assert.equal(history.dailySeries(config, 'gazole').length, 1);
});

test('a corrupt file is ignored rather than crashing the boot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fuel-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'price-history.json');
  await (await import('node:fs/promises')).writeFile(file, '{ truncated', 'utf8');

  const { history } = historyAt(Date.now(), file);
  await assert.doesNotReject(() => history.load());
  assert.equal(history.size, 0);
});

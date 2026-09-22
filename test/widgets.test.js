// -----------------------------------------------------------------------------
// Dashboard widgets.
//
// Two things are worth testing here, and nothing else is:
//   - the CONTENT BUDGET, because the core silently drops whatever exceeds it —
//     a violation never throws, it just leaves a hole in someone's dashboard;
//   - what each card actually says in the states that matter (no postal code,
//     no price, a tracked fuel vs an untracked one).
//
// No network: the station store is fed by a fake provider, like everywhere else.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { createStationStore } from '../src/stationStore.js';
import { createPriceHistory } from '../src/priceHistory.js';
import { deviceExternalId } from '../src/devices/index.js';
import {
  BUDGET,
  LIMITS,
  boundedText,
  buildContent,
  button,
  text,
  valueTile,
} from '../src/widgets/content.js';
import {
  WIDGET_KEYS,
  buildWidgetManifest,
  getWidgetContent,
  notifyWidgetsChanged,
  registerWidgets,
  runWidgetAction,
} from '../src/widgets/index.js';
import {
  ROW_LABEL_MAX,
  buildRowLabels,
  formatShortDate,
  shortenStationName,
} from '../src/widgets/format.js';
import { createFakeGladys, createFakeProvider, createStation } from './helpers/fakeGladys.js';

const config = normalizeConfig({ postal_code: '35000', fuel_type: ['gazole', 'sp98'] });

function contextWith(stations, { history } = {}) {
  const provider = createFakeProvider({ stations });
  const store = createStationStore({ resolveProvider: () => provider });
  return { context: { config, store, history }, provider, store };
}

/** A price history driven by the test's own clock, written nowhere. */
function historyWith(samples = []) {
  let clock = Date.UTC(2026, 8, 19, 10);
  const history = createPriceHistory({ file: '/etc/hostname/nope.json', now: () => clock });
  for (const { daysAgo, price } of samples) {
    clock = Date.UTC(2026, 8, 19, 10) - daysAgo * 24 * 60 * 60 * 1000;
    history.record(config, [createStation({ prices: { gazole: price } })]);
  }
  clock = Date.UTC(2026, 8, 19, 10);
  return history;
}

/** Components of one type, in the order they were sent. */
const componentsOfType = (content, type) => content.components.filter((c) => c.type === type);

// --- The vocabulary ----------------------------------------------------------

test('a text is truncated per language, with an ellipsis', () => {
  const bounded = boundedText({ en: 'x'.repeat(50), fr: 'court' }, LIMITS.HEADING);
  assert.equal(bounded.en.length, LIMITS.HEADING);
  assert.ok(bounded.en.endsWith('…'));
  assert.equal(bounded.fr, 'court');
});

test('an empty text is omitted rather than sent as an empty string', () => {
  assert.equal(boundedText('   ', 40), undefined);
  assert.equal(boundedText(null, 40), undefined);
  assert.equal(text({ text: '' }), null);
});

test('a tile bound to a device feature carries no inline value', () => {
  const tile = valueTile({
    label: 'Gazole',
    deviceFeature: 'ext:x:fuel-station:FR-1-gazole:price',
  });
  assert.equal(tile.device_feature, 'ext:x:fuel-station:FR-1-gazole:price');
  assert.equal(tile.value, undefined, 'the value comes from the feature');
  assert.equal(tile.unit, undefined, 'so does the unit');
});

test('a button must carry exactly one kind of action', () => {
  assert.equal(button({ label: 'Go' }), null, 'no kind at all');
  assert.equal(
    button({ label: 'Go', action: { key: 'refresh' }, link: { url: 'https://example.com' } }),
    null,
    'two kinds',
  );
  assert.equal(button({ label: 'Go', link: { url: 'http://example.com' } }), null, 'http refused');
});

test('the content budget drops the extra components in content order', () => {
  const tiles = Array.from({ length: 9 }, (_, i) => valueTile({ label: `t${i}`, value: i }));
  const content = buildContent([...tiles, button({ label: 'Go', action: { key: 'refresh' } })]);

  assert.equal(componentsOfType(content, 'value').length, BUDGET.TILES);
  assert.equal(content.components.length <= BUDGET.COMPONENTS, true);
  assert.equal(componentsOfType(content, 'value')[0].label, 't0', 'the first ones win');
});

test('the ttl is clamped to what the core accepts', () => {
  assert.equal(buildContent([], { ttlSeconds: 1 }).ttl_seconds, LIMITS.TTL_MIN);
  assert.equal(buildContent([], { ttlSeconds: 99999 }).ttl_seconds, LIMITS.TTL_MAX);
});

// --- The ack deadline --------------------------------------------------------

test('a pull slower than the deadline answers a warming card instead of nothing', async () => {
  // The core acks `widget.get` under 15 s and the front turns a missed ack into
  // "widget data unavailable", drops the content it had and schedules NO retry:
  // the card stays dead until someone reloads the dashboard. So a slow feed
  // must never be allowed to reach that deadline.
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const provider = createFakeProvider({ stations: [createStation()] });
  const searchStations = provider.searchStations;
  provider.searchStations = async (params) => {
    await slow;
    return searchStations(params);
  };
  const store = createStationStore({ resolveProvider: () => provider });

  const content = await getWidgetContent(
    createFakeGladys(),
    { config, store },
    'best_prices',
    {},
    { deadlineMs: 5 },
  );

  assert.equal(componentsOfType(content, 'status').length, 0, 'no ranking yet');
  assert.equal(content.components.length, 1, 'one sentence, nothing else');
  assert.ok(content.components[0].text.fr.includes('flux open data'));
  assert.ok(content.ttl_seconds <= 30, 'a short TTL: the core re-pulls right after');

  // The abandoned pull keeps running and warms the cache, which is the whole
  // point: the next pull is served from memory, well inside the deadline.
  release();
  await new Promise((resolve) => setImmediate(resolve));
  const second = await getWidgetContent(
    createFakeGladys(),
    { config, store },
    'best_prices',
    {},
    { deadlineMs: 1000 },
  );
  assert.equal(componentsOfType(second, 'status').length, 1, 'the card filled itself');
});

test('a pull that fails still reports the failure rather than a warming card', async () => {
  const provider = createFakeProvider({ stations: [] });
  provider.searchStations = async () => {
    throw new Error('the open data API is down');
  };
  const store = createStationStore({ resolveProvider: () => provider });

  // The core turns a thrown error into a message the user can act on; only a
  // MISSED ack is the failure with no explanation, and that is what the
  // deadline exists for.
  await assert.rejects(
    () => getWidgetContent(createFakeGladys(), { config, store }, 'best_prices', {}),
    /the open data API is down/,
  );
});

// --- "Cheapest around me" ----------------------------------------------------

test('the ranking sorts the stations by price and badges the cheapest', async () => {
  const cheap = createStation({ id: '1', name: 'Cheap', prices: { gazole: 1.599 } });
  const pricey = createStation({ id: '2', name: 'Pricey', prices: { gazole: 1.899 } });
  const { context } = contextWith([pricey, cheap]);
  const gladys = createFakeGladys();

  const content = await getWidgetContent(gladys, context, 'best_prices', {
    settings: { fuel: 'gazole', scope: 'around', count: '5' },
    language: 'fr',
  });

  const [ranking] = componentsOfType(content, 'status');
  assert.deepEqual(
    ranking.items.map((item) => item.label),
    ['Cheap', 'Pricey'],
  );
  assert.equal(ranking.items[0].color, 'success', 'the cheapest one stands out');
  assert.equal(
    ranking.items[0].value,
    `1,599 · ${formatShortDate('2026-08-06T07:12:00+02:00', 'fr')}`,
    'the price, and the day the station declared it — short enough for a phone',
  );
  assert.ok(
    ranking.items[0].value.length <= 14,
    'the row must survive a phone screen, where the front cuts it',
  );

  // TEXT, three decimals, French separator: the front rounds an inline NUMBER
  // to two decimals, which turned 1,699 € into "1,7" on a real dashboard.
  const [cheapest, average] = componentsOfType(content, 'value');
  assert.equal(cheapest.value, '1,599');
  assert.equal(cheapest.unit, '€/L');
  assert.equal(average.value, '1,749');

  const [heading] = componentsOfType(content, 'text');
  assert.equal(heading.variant, 'heading');
  assert.equal(heading.text.fr, 'Gazole · 10 km autour du 35000', 'the area is named');
});

test('the ranking honours the number of stations asked for', async () => {
  const stations = Array.from({ length: 6 }, (_, i) =>
    createStation({ id: String(i), name: `S${i}`, prices: { gazole: 1.5 + i / 100 } }),
  );
  const { context } = contextWith(stations);

  const content = await getWidgetContent(createFakeGladys(), context, 'best_prices', {
    settings: { fuel: 'gazole', count: '3' },
  });

  assert.equal(componentsOfType(content, 'status')[0].items.length, 3);
});

test('a station with no price for the chosen fuel is left out of the ranking', async () => {
  const { context } = contextWith([createStation({ prices: { gazole: 1.699, gplc: null } })]);

  const content = await getWidgetContent(createFakeGladys(), context, 'best_prices', {
    settings: { fuel: 'gplc' },
  });

  assert.equal(componentsOfType(content, 'status').length, 0);
  assert.equal(componentsOfType(content, 'text').length, 1, 'an explanation, not an empty card');
});

test('without a postal code the card says what to do instead of failing', async () => {
  const provider = createFakeProvider({ stations: [createStation()] });
  const store = createStationStore({ resolveProvider: () => provider });
  const content = await getWidgetContent(
    createFakeGladys(),
    { config: normalizeConfig(), store },
    'best_prices',
    {},
  );

  assert.equal(componentsOfType(content, 'text').length, 1);
  assert.equal(provider.calls.search, 0, 'nothing is searched without a postal code');
});

test('the "my stations" scope ranks the tracked stations only', async () => {
  const mine = createStation({ id: '1', name: 'Mine', prices: { gazole: 1.8 } });
  const other = createStation({ id: '2', name: 'Other', prices: { gazole: 1.5 } });
  const { context, store, provider } = contextWith([mine, other]);
  store.setTracked([{ country: 'FR', stationId: '1' }]);

  const content = await getWidgetContent(createFakeGladys(), context, 'best_prices', {
    settings: { scope: 'tracked' },
  });

  assert.deepEqual(
    componentsOfType(content, 'status')[0].items.map((item) => item.label),
    ['Mine'],
  );
  assert.equal(provider.calls.search, 0, 'tracked stations are fetched by id, not searched');
});

// --- "My station" ------------------------------------------------------------

test('every price tile carries the three decimals of the pump, tracked or not', async () => {
  // The tiles used to be bound to the device feature for a tracked fuel. The
  // front renders a bound feature through `DeviceFeatureValueText`, which
  // rounds to ONE decimal: 1,699 € reached the card as "1,7" while the device
  // page of the same feature showed 1,699. Text, and nothing rounds it.
  const station = createStation({ prices: { gazole: 1.699, sp98: 1.879 } });
  const { context } = contextWith([station]);
  const gladys = createFakeGladys();
  const target = { country: 'FR', stationId: station.id, fuel: 'gazole' };
  gladys.devices = [{ external_id: deviceExternalId(gladys, target), name: 'Ma station' }];

  const content = await getWidgetContent(gladys, context, 'station', {
    settings: { device: deviceExternalId(gladys, target) },
    language: 'fr',
  });

  const tiles = componentsOfType(content, 'value');
  assert.equal(tiles[0].value, '1,699', 'the fuel the device tracks');
  assert.equal(tiles[0].device_feature, undefined, 'no binding: the front would round it');
  assert.equal(tiles[0].unit, '€/L');
  const sp98 = tiles.find((tile) => tile.label.en === 'SP98');
  assert.equal(sp98.value, '1,879', 'and the fuel no device tracks');
  assert.equal(sp98.unit, '€/L');

  // English keeps the dot, since the core renders the card in the language of
  // whoever is looking at it.
  const inEnglish = await getWidgetContent(gladys, context, 'station', {
    settings: { device: deviceExternalId(gladys, target) },
  });
  assert.equal(componentsOfType(inEnglish, 'value')[0].value, '1.699');
});

test('the station card stays within the budget and names the station', async () => {
  const station = createStation({
    prices: { gazole: 1.699, sp95: 1.799, sp98: 1.879, e10: 1.729, e85: 0.899, gplc: 0.999 },
  });
  const { context } = contextWith([station]);
  const gladys = createFakeGladys();

  const content = await getWidgetContent(gladys, context, 'station', {
    settings: {
      device: deviceExternalId(gladys, { country: 'FR', stationId: station.id, fuel: 'gazole' }),
    },
  });

  assert.ok(content.components.length <= BUDGET.COMPONENTS);
  assert.equal(componentsOfType(content, 'status').length, 1);
  assert.equal(componentsOfType(content, 'text')[0].text, station.name);
  assert.ok(componentsOfType(content, 'value').length <= 4, 'four fuels at most, budget bound');
  assert.equal(componentsOfType(content, 'button').length, 2, 'directions + refresh');
});

test('the status rows carry the address and the declared date, in our date format', async () => {
  const { context } = contextWith([createStation()]);
  const gladys = createFakeGladys();

  const content = await getWidgetContent(gladys, context, 'station', {
    settings: {
      device: deviceExternalId(gladys, { country: 'FR', stationId: '35000001', fuel: 'gazole' }),
    },
  });

  const rows = componentsOfType(content, 'status')[0].items;
  assert.ok(rows.some((row) => row.value === '1 rue de Nantes 35000 Rennes'));
  assert.ok(rows.some((row) => row.value === '06/08/2026 à 07:12'));
});

test('a widget with no station selected asks for one instead of erroring', async () => {
  const { context } = contextWith([createStation()]);

  const content = await getWidgetContent(createFakeGladys(), context, 'station', { settings: {} });

  assert.equal(componentsOfType(content, 'text').length, 1);
  assert.equal(componentsOfType(content, 'value').length, 0);
});

// --- Registry ----------------------------------------------------------------

test('an unknown widget key is an error, never an empty card', async () => {
  const { context } = contextWith([]);
  await assert.rejects(
    () => getWidgetContent(createFakeGladys(), context, 'nope', {}),
    /Unknown widget/,
  );
});

test('the refresh action drops the cache so the next read hits the feed', async () => {
  const { context, provider, store } = contextWith([createStation()]);
  await store.search(config);
  assert.equal(provider.calls.search, 1);

  const message = await runWidgetAction(createFakeGladys(), context, 'best_prices', 'refresh');
  assert.ok(message.fr, 'the message shown under the button is bilingual');

  await store.search(config);
  assert.equal(provider.calls.search, 2);
});

test('an unknown action is rejected rather than silently ignored', async () => {
  const { context } = contextWith([]);
  await assert.rejects(
    () => runWidgetAction(createFakeGladys(), context, 'station', 'explode'),
    /Unknown action/,
  );
});

test('every declared widget is registered on both SDK members', async () => {
  const { context } = contextWith([createStation()]);
  const gets = new Map();
  const actions = new Map();
  const gladys = {
    ...createFakeGladys(),
    onWidgetGet: (key, callback) => gets.set(key, callback),
    onWidgetAction: (key, callback) => actions.set(key, callback),
  };

  registerWidgets(gladys, () => context);

  assert.deepEqual([...gets.keys()], WIDGET_KEYS);
  assert.deepEqual([...actions.keys()], WIDGET_KEYS);
  assert.deepEqual(
    buildWidgetManifest().map((widget) => widget.key),
    WIDGET_KEYS,
  );

  // The callbacks are the real path the core takes, so run them: a registration
  // that hands back a broken closure is the failure this guards.
  const content = await gets.get('best_prices')({ settings: { fuel: 'gazole' }, language: 'fr' });
  assert.equal(content.version, 1);
  assert.ok(content.components.length > 0);

  const result = await actions.get('best_prices')('refresh', {}, { settings: {} });
  assert.ok(result.fr, 'the toast shown under the button');
});

test('a registered widget reads the configuration in force when the card is pulled', async () => {
  // Same contract as the scene actions: the context is read at CALL time, so a
  // card pulled after onConfigUpdated is built from the new postal code.
  const gets = new Map();
  const gladys = {
    ...createFakeGladys(),
    onWidgetGet: (key, callback) => gets.set(key, callback),
    onWidgetAction: () => {},
  };
  let context = contextWith([createStation({ prices: { gazole: 1.699 } })]).context;
  registerWidgets(gladys, () => context);

  const first = await gets.get('best_prices')({ settings: { fuel: 'gazole' }, language: 'fr' });
  context = contextWith([createStation({ prices: { gazole: 1.409 } })]).context;
  const second = await gets.get('best_prices')({ settings: { fuel: 'gazole' }, language: 'fr' });

  const focal = (content) => componentsOfType(content, 'value')[0].value;
  assert.notEqual(focal(first), focal(second), 'the card followed the new context');
});

test('the nudge names every widget, and never throws when the core refuses one', () => {
  const nudged = [];
  const gladys = { ...createFakeGladys(), requestWidgetRefresh: (key) => nudged.push(key) };

  notifyWidgetsChanged(gladys);
  assert.deepEqual(nudged, WIDGET_KEYS);

  // `requestWidgetRefresh` throws synchronously on a key the core would refuse,
  // and the SDK drops a nudge sent while the socket is down: a freshness hint
  // must never cost the refresh pass that carried it.
  const refusing = {
    ...createFakeGladys(),
    requestWidgetRefresh: () => {
      throw new Error('socket is closed');
    },
  };
  assert.doesNotThrow(() => notifyWidgetsChanged(refusing));
});

// --- The card of the mockup: curve, trend, read time -------------------------

test('with enough history the card draws the curve and the 7-day trend', async () => {
  const history = historyWith([
    { daysAgo: 20, price: 1.8 },
    { daysAgo: 8, price: 1.75 },
    { daysAgo: 1, price: 1.72 },
  ]);
  const { context } = contextWith([createStation({ prices: { gazole: 1.72 } })], { history });

  const content = await getWidgetContent(createFakeGladys(), context, 'best_prices', {
    settings: { fuel: 'gazole' },
    language: 'fr',
  });

  const [curve] = componentsOfType(content, 'chart');
  assert.equal(curve.chart_type, 'area');
  assert.equal(curve.title.fr, '30 derniers jours');
  assert.equal(curve.unit, '€/L');
  assert.ok(curve.series[0].points.length >= 3);

  const trend = componentsOfType(content, 'value').find((tile) => tile.unit === 'ct');
  assert.ok(trend, 'the trend tile is there once the window is covered');
  assert.equal(trend.value, -3, '1,72 today against 1,75 a week ago');
  assert.equal(trend.color, 'success', 'cheaper than last week is good news');

  // The whole card still fits: heading, 3 tiles, caption, chart, status, map.
  assert.ok(content.components.length <= BUDGET.COMPONENTS);
  assert.equal(componentsOfType(content, 'status').length, 1, 'chart and list coexist');
});

test('a price that went up is shown as such', async () => {
  const history = historyWith([
    { daysAgo: 9, price: 1.65 },
    { daysAgo: 0, price: 1.7 },
  ]);
  const { context } = contextWith([createStation({ prices: { gazole: 1.7 } })], { history });

  const content = await getWidgetContent(createFakeGladys(), context, 'best_prices', {
    settings: { fuel: 'gazole' },
  });

  const trend = componentsOfType(content, 'value').find((tile) => tile.unit === 'ct');
  assert.equal(trend.value, 5);
  assert.equal(trend.color, 'danger');
  assert.equal(trend.icon, 'trending-up');
});

test('a fresh install already draws its curve, with the point it has', async () => {
  const { context } = contextWith([createStation({ prices: { gazole: 1.66 } })], {
    history: historyWith(),
  });

  const content = await getWidgetContent(createFakeGladys(), context, 'best_prices', {
    settings: { fuel: 'gazole' },
  });

  const [curve] = componentsOfType(content, 'chart');
  assert.ok(curve, 'the card shows its curve from day one, and fills it afterwards');
  const points = curve.series[0].points;
  assert.ok(points.every((point) => point.v === 1.66));
  // The last point is NOW: an axis drawn from a single point spreads into the
  // future, and a price curve must never show tomorrow.
  const last = new Date(points[points.length - 1].t).getTime();
  assert.ok(Date.now() - last < 5000, 'the curve ends on the price just read');

  const trend = componentsOfType(content, 'value').find((tile) => tile.label.fr === 'Sur 7 jours');
  assert.ok(trend, 'the tile is on the card from day one');
  assert.equal(trend.value, '—', 'a dash, never a zero, until a real week is covered');
});

test('the curve never ends in the future, whatever the history holds', async () => {
  const history = historyWith([
    { daysAgo: 12, price: 1.8 },
    { daysAgo: 3, price: 1.74 },
  ]);
  const { context } = contextWith([createStation({ prices: { gazole: 1.71 } })], { history });

  const content = await getWidgetContent(createFakeGladys(), context, 'best_prices', {
    settings: { fuel: 'gazole' },
  });

  const points = componentsOfType(content, 'chart')[0].series[0].points;
  const times = points.map((point) => new Date(point.t).getTime());
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
    'oldest first',
  );
  assert.ok(times[times.length - 1] <= Date.now(), 'nothing is dated in the future');
  assert.equal(points[points.length - 1].v, 1.71, 'and it ends on the price just read');
});

test('the curve is drawn even when nothing could be recorded at all', async () => {
  // No history module: a `/data` that cannot be read, an older wiring.
  const { context } = contextWith([createStation({ prices: { gazole: 1.66 } })]);

  const content = await getWidgetContent(createFakeGladys(), context, 'best_prices', {
    settings: { fuel: 'gazole' },
  });

  assert.equal(componentsOfType(content, 'chart').length, 1);
});

test('the card says when the prices were read, and links to the official map', async () => {
  const { context, store } = contextWith([createStation()]);
  await store.search(config);

  const content = await getWidgetContent(createFakeGladys(), context, 'best_prices', {
    settings: { fuel: 'gazole' },
  });

  const caption = componentsOfType(content, 'text').find((one) => one.variant === 'caption');
  assert.match(caption.text.fr, /^Prix relevés le \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}$/);

  const link = componentsOfType(content, 'button').find((one) => one.link);
  assert.match(link.link.url, /^https:\/\/www\.prix-carburants\.gouv\.fr/);
});

test('a widget pull feeds the history, so the curve builds itself', async () => {
  const history = historyWith();
  const { context } = contextWith([createStation({ prices: { gazole: 1.61 } })], { history });

  await getWidgetContent(createFakeGladys(), context, 'best_prices', {
    settings: { fuel: 'gazole', scope: 'around' },
  });

  assert.equal(history.dailySeries(config, 'gazole').length, 1);
});

test('the station card names what the distance is measured from', async () => {
  const { context } = contextWith([createStation()]);
  const gladys = createFakeGladys();

  const content = await getWidgetContent(gladys, context, 'station', {
    settings: {
      device: deviceExternalId(gladys, { country: 'FR', stationId: '35000001', fuel: 'gazole' }),
    },
  });

  const rows = componentsOfType(content, 'status')[0].items;
  const distance = rows.find((row) => row.label.fr === 'Distance');
  assert.equal(distance.value.fr, '1,2 km du 35000');
  assert.ok(
    rows.some((row) => row.value === '06/08/2026 à 07:12'),
    'the last price update stays on the card',
  );
});

// --- Measured from the house -------------------------------------------------

/** A house module answering with fixed coordinates, or nothing. */
const houseThat = (located) => ({ get: async () => located });

test('the heading says the distances start at the house when they do', async () => {
  const { context } = contextWith([createStation()]);
  context.house = houseThat({ name: 'Maison', latitude: 48.11, longitude: -1.68 });

  const content = await getWidgetContent(createFakeGladys(), context, 'best_prices', {
    settings: { fuel: 'gazole' },
  });

  const [heading] = componentsOfType(content, 'text');
  assert.equal(heading.text.fr, 'Gazole · 10 km autour de ma maison');
  assert.equal(heading.text.en, 'Diesel · within 10 km of my home');
});

test('an unlocated house falls back on the postal code, in the wording too', async () => {
  const { context } = contextWith([createStation()]);
  context.house = houseThat(null);

  const content = await getWidgetContent(createFakeGladys(), context, 'best_prices', {
    settings: { fuel: 'gazole' },
  });

  assert.equal(componentsOfType(content, 'text')[0].text.fr, 'Gazole · 10 km autour du 35000');
});

test('the station card measures from the house when there is one', async () => {
  const { context } = contextWith([createStation()]);
  context.house = houseThat({ name: 'Maison', latitude: 48.11, longitude: -1.68 });
  const gladys = createFakeGladys();

  const content = await getWidgetContent(gladys, context, 'station', {
    settings: {
      device: deviceExternalId(gladys, { country: 'FR', stationId: '35000001', fuel: 'gazole' }),
    },
  });

  const rows = componentsOfType(content, 'status')[0].items;
  assert.equal(rows.find((row) => row.label.fr === 'Distance').value.fr, '1,2 km de la maison');
});

test('the search is centred on the house, so the provider measures from it', async () => {
  const provider = createFakeProvider({ stations: [createStation()] });
  const store = createStationStore({
    resolveProvider: () => provider,
    resolveCenter: async () => ({
      center: { latitude: 48.11, longitude: -1.68 },
      source: 'house',
    }),
  });
  let received;
  const search = provider.searchStations;
  provider.searchStations = async (options) => {
    received = options;
    return search(options);
  };

  await store.search(config);

  assert.deepEqual(received.center, { latitude: 48.11, longitude: -1.68 });
});

test('a single sample is anchored to the start of its day, never to the future', async () => {
  // The day the card is added: one measurement, and nothing behind it.
  const { context } = contextWith([createStation({ prices: { gazole: 1.88 } })]);

  const content = await getWidgetContent(createFakeGladys(), context, 'best_prices', {
    settings: { fuel: 'gazole' },
  });

  const points = componentsOfType(content, 'chart')[0].series[0].points;
  assert.equal(points.length, 2, 'one point makes ApexCharts spread its axis into next week');
  assert.ok(
    points.every((point) => point.v === 1.88),
    'the anchor carries the measured price',
  );
  const anchor = new Date(points[0].t);
  assert.equal(
    anchor.getHours() + anchor.getMinutes() + anchor.getSeconds(),
    0,
    'start of the day',
  );
  assert.ok(new Date(points[1].t).getTime() <= Date.now());
});

// --- The short date of the ranking rows --------------------------------------

test('the declared date is shortened to the day, in the reader language', () => {
  const now = new Date(2026, 8, 22, 9, 30);

  assert.equal(formatShortDate('2026-09-22T06:12:00+02:00', 'fr', now), 'auj.');
  assert.equal(formatShortDate('2026-09-22T06:12:00+02:00', 'en', now), 'today');
  assert.equal(formatShortDate('2026-09-21T23:50:00+02:00', 'fr', now), 'hier');
  assert.equal(formatShortDate('2026-09-21T23:50:00+02:00', 'en', now), 'yest.');
  // Inside the year, the year is implied; beyond it, it is not.
  assert.equal(formatShortDate('2026-08-06T07:12:00+02:00', 'fr', now), '06/08');
  assert.equal(formatShortDate('2025-12-31T07:12:00+02:00', 'fr', now), '31/12/25');
});

test('the short date keeps the declared wall-clock day, not the container one', () => {
  // 00:30 in Paris is 22:30 the day before in UTC, where the container runs:
  // read as an instant, a price declared today would be dated yesterday.
  const now = new Date(2026, 8, 22, 9, 30);
  assert.equal(formatShortDate('2026-09-22T00:30:00+02:00', 'fr', now), 'auj.');
});

test('the short date shows nothing when the feed says nothing', () => {
  assert.equal(formatShortDate(undefined, 'fr'), '');
  assert.equal(formatShortDate('', 'fr'), '');
  assert.equal(formatShortDate('not a date', 'fr'), 'not a date', 'the raw value beats nothing');
});

// --- The width of a ranking row ----------------------------------------------

test('a long station name is shortened so the price and its date keep their room', async () => {
  const long = createStation({
    id: '1',
    name: 'TotalEnergies - Oullins-Pierre-Bénite',
    prices: { gazole: 1.599 },
  });
  const { context } = contextWith([long]);

  const content = await getWidgetContent(createFakeGladys(), context, 'best_prices', {
    settings: { fuel: 'gazole', scope: 'around', count: '5' },
    language: 'fr',
  });

  const [ranking] = componentsOfType(content, 'status');
  assert.ok(
    ranking.items[0].label.length <= ROW_LABEL_MAX,
    'the label is bounded well under what the core accepts, because it shares the line',
  );
  assert.ok(
    `${ranking.items[0].label} ${ranking.items[0].value}`.length <= 40,
    'label plus value is what a phone has to fit on one line',
  );
  assert.ok(
    ranking.items[0].value.endsWith(formatShortDate('2026-08-06T07:12:00+02:00', 'fr')),
    'the date survives the row',
  );
});

test('shortening a name serves the place first and compacts the brand', () => {
  // Short enough: untouched.
  assert.equal(shortenStationName('Total - Rennes'), 'Total - Rennes');
  // A compound brand goes back to its root, which loses nothing at all: a
  // driver reads "Total" as their station, and the town stays whole — it is the
  // only thing telling this station from the four others of the same chain.
  assert.equal(shortenStationName('TotalEnergies - La Mulatière'), 'Total - La Mulatière');
  assert.equal(shortenStationName('TotalEnergies Access - Lyon 7e'), 'Total Access - Lyon 7e');
  // A place too long for the row takes what the brand does not need, and the
  // brand is never dropped: a row naming no brand names no station.
  assert.equal(
    shortenStationName('TotalEnergies - Oullins-Pierre-Bénite'),
    'Total - Oullins-Pierre…',
  );
  // A street is cut, not compacted: "141 Boulevard" reads as a street called
  // Boulevard, where "141 Boulevard…" says plainly that something was cut.
  assert.equal(
    shortenStationName('141 Boulevard Émile Zola - Oullins'),
    '141 Boulevard… - Oullins',
  );
  // Three segments in 24 characters would be three stumps: the middle one is
  // dropped, and `buildRowLabels` brings it back only where it is needed.
  assert.equal(
    shortenStationName('TotalEnergies - Av. du Général de Gaulle - Oullins-Pierre-Bénite'),
    'Total - Oullins-Pierre…',
  );
  assert.equal(shortenStationName(undefined), '');
});

test('a ranking never shows the same label twice', () => {
  // Three rows of a dashboard where one chain owns the area: cut on their own,
  // the first two both read "Total Access - Lyon 7e".
  const labels = buildRowLabels([
    { name: 'TotalEnergies Access - Av. Jean Jaurès - Lyon 7e' },
    { name: 'TotalEnergies Access - Rue Garibaldi - Lyon 7e' },
    { name: 'TotalEnergies - Oullins' },
  ]);
  assert.equal(new Set(labels).size, labels.length, 'no two rows read the same');
  // The city is shared, so the city says nothing: those rows show their street
  // instead — and they still say whose station it is.
  assert.equal(labels[0], 'Total - Av. Jean Jaurès');
  assert.equal(labels[1], 'Total - Rue Garibaldi');
  // A row that is the only one of its city is left exactly as it was.
  assert.equal(labels[2], 'TotalEnergies - Oullins');
  for (const label of labels) {
    assert.ok(label.length <= ROW_LABEL_MAX, `"${label}" fits the row`);
  }
});

test('a row alone in a big city still says which street it is on, and where', () => {
  // The row that started this: "TotalEnergies - Lyon" is a city of half a
  // million people, and three of the five rows named it. The street is not in
  // the name — the device list only spells it out to keep two devices apart —
  // so it comes from the station's own address.
  const labels = buildRowLabels([
    { name: 'Total - Oullins-Pierre-Bénite', address: '141 Boulevard Émile Zola' },
    { name: 'Total - Lyon', address: 'AVENUE TONY GARNIER' },
    { name: 'TotalEnergies - Lyon', address: '112/116 RUE DE GERLAND' },
  ]);
  assert.equal(labels[0], 'Total - Oullins-Pierre…', 'a city of its own is kept');
  // The city comes back BEHIND the street, because a street on its own asks
  // where it is and no other row answers: it is the street that pays for the
  // room, reduced to the name a local says (the house number and the kind of
  // way are what every other street of the city carries too).
  assert.equal(labels[1], 'Total - Garnier, Lyon');
  assert.equal(labels[2], 'Total - Gerland, Lyon');
  for (const label of labels) {
    assert.ok(label.length <= ROW_LABEL_MAX, `"${label}" fits the row`);
  }
});

test('the city is dropped again when keeping it would cost the rows their street', () => {
  // Two streets of one avenue's name: shortened far enough to let "Lyon" in,
  // both rows would read "… Hugo, Lyon" and the ranking would stop telling
  // them apart — which is the one thing it is for.
  const merging = buildRowLabels([
    { name: 'Total - Lyon', address: 'RUE VICTOR HUGO' },
    { name: 'Esso - Lyon', address: 'AVENUE VICTOR HUGO' },
  ]);
  assert.deepEqual(merging, ['Total - Rue Victor Hugo', 'Esso - Av. Victor Hugo']);
  // A city long enough to eat the row leaves nothing for the street either:
  // the street stays whole and the city goes, as before.
  const crowded = buildRowLabels([
    { name: 'Total - Villeurbanne', address: 'RUE VICTOR HUGO' },
    { name: 'Total - Villeurbanne', address: 'AVENUE ROGER SALENGRO' },
  ]);
  assert.deepEqual(crowded, ['Total - Rue Victor Hugo', 'Total - Av. Roger Salen…']);
  for (const label of [...merging, ...crowded]) {
    assert.ok(label.length <= ROW_LABEL_MAX, `"${label}" fits the row`);
  }
});

test('a row with nothing more to show keeps its brand', () => {
  // The third name has no street to reveal: rewriting it would cost it its
  // brand although the other two stop clashing with it on their own.
  const labels = buildRowLabels([
    { name: 'TotalEnergies Access - Av. Jean Jaurès - Lyon 7e' },
    { name: 'TotalEnergies Access - Rue Garibaldi - Lyon 7e' },
    { name: 'TotalEnergies Access - Lyon 7e' },
  ]);
  assert.equal(new Set(labels).size, 3);
  assert.equal(labels[2], 'Total Access - Lyon 7e');
});

test('two long names cut to the same city fall back on the city itself', () => {
  const labels = buildRowLabels([
    { name: 'Intermarché - Saint-Germain-en-Laye' },
    { name: 'Intermarché - Saint-Germain-lès-Corbeil' },
  ]);
  assert.equal(new Set(labels).size, 2);
  // Nothing but the city differs, so the city is what takes the whole row.
  assert.ok(labels.every((label) => label.startsWith('Saint-Germain')));
});

test('two stations of the very same name are left equal rather than numbered', () => {
  // `disambiguateStationNames` already appends the id upstream when it can;
  // there is nothing for the display layer to win back here.
  const labels = buildRowLabels([{ name: 'Total - Rennes' }, { name: 'Total - Rennes' }]);
  assert.deepEqual(labels, ['Total - Rennes', 'Total - Rennes']);
});

test('a row shows the street rather than the technical id of the station', () => {
  // Real rows of a Lyon dashboard: 69007008 and 69007009 are two pumps of the
  // same avenue, declaring the very same address, so the name built upstream
  // ends on the national id — and the row used to keep THAT and drop the
  // street, reading "Total - Lyon (69007008)". The id names nothing to a
  // driver; the avenue does, even written twice.
  const labels = buildRowLabels([
    { name: 'Total - Av. Tony Garnier - Lyon (69007008)', address: 'AVENUE TONY GARNIER' },
    { name: 'Total - Av. Tony Garnier - Lyon (69007009)', address: 'AVENUE TONY GARNIER' },
    { name: 'TotalEnergies - Oullins' },
  ]);
  assert.deepEqual(labels, [
    'Total - Garnier, Lyon',
    'Total - Garnier, Lyon',
    'TotalEnergies - Oullins',
  ]);
  for (const label of labels) {
    assert.ok(label.length <= ROW_LABEL_MAX, `"${label}" fits the row`);
  }
});

test('a station with no street at all keeps the id that is all it has', () => {
  // Nothing behind the id here — no street in the name, none in the station:
  // dropping it would make the row say strictly less.
  const labels = buildRowLabels([
    { name: 'Total - Lyon (69007008)' },
    { name: 'Total - Lyon (69007009)' },
  ]);
  assert.deepEqual(labels, ['Total - Lyon (69007008)', 'Total - Lyon (69007009)']);
});

test('a station named after its address does not repeat that address', () => {
  // No brand: the name already IS the street, so there is nothing to insert
  // behind it.
  const labels = buildRowLabels([
    { name: '141 Boulevard Émile Zola - Oullins', address: '141 Boulevard Émile Zola' },
    { name: 'Total - Oullins', address: 'Rue de la Gare' },
  ]);
  assert.equal(labels[0], '141 Boulevard… - Oullins');
  assert.equal(labels[1], 'Total - Gare, Oullins');
});

test('a street is written the way a street is written, not the way the feed stores it', () => {
  // "Lyon 7e" leaves no room for a city behind the street, so the streets are
  // shown whole here — which is where their spelling is read.
  const labels = buildRowLabels([
    { name: 'Total - Lyon 7e', address: "RUE D'ARCOLE" },
    { name: 'Avia - Lyon 7e', address: 'ZA DE LA PLAINE' },
    { name: 'Esso - Lyon 7e', address: 'AVENUE TONY GARNIER' },
  ]);
  // Capitals go back to title case, the particles stay lowercase, and the
  // abbreviations `shortenAddress` produces are not turned into words.
  assert.deepEqual(labels, [
    "Total - Rue d'Arcole",
    'Avia - ZA de la Plaine',
    'Esso - Av. Tony Garnier',
  ]);
  // Shortened for a city that does fit, the street keeps its name and loses
  // what says only what kind of way it is.
  assert.deepEqual(
    buildRowLabels([
      { name: 'Total - Lyon', address: "RUE D'ARCOLE" },
      { name: 'Avia - Lyon', address: 'ZA DE LA PLAINE' },
      { name: 'Esso - Lyon', address: 'AVENUE TONY GARNIER' },
    ]),
    ['Total - Arcole, Lyon', 'Avia - Plaine, Lyon', 'Esso - Garnier, Lyon'],
  );
});

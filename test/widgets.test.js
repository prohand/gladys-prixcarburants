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
import { createFakeGladys, createFakeProvider, createStation } from './helpers/fakeGladys.js';
import { EventEmitter } from 'node:events';

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

/**
 * A stand-in for the SDK's WebSocket: it records what we send and lets a test
 * push an incoming frame, which is all the bridge touches.
 */
function createFakeSocket() {
  const socket = new EventEmitter();
  socket.readyState = 1; // OPEN
  socket.sent = [];
  socket.send = (raw) => socket.sent.push(JSON.parse(raw));
  /** Push a frame and resolve with the message we answered, if any. */
  socket.receive = async (message) => {
    const before = socket.sent.length;
    socket.emit('message', Buffer.from(JSON.stringify(message)));
    // The handler is async; let its microtasks (and the store's) settle.
    for (let i = 0; i < 20 && socket.sent.length === before; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return socket.sent[before];
  };
  return socket;
}

/** An SDK instance without widget support, holding a fake socket. */
function bridgedGladys(stations) {
  const { context, store, provider } = contextWith(stations);
  const socket = createFakeSocket();
  const gladys = Object.assign(new EventEmitter(), createFakeGladys(), { ws: socket });
  return { context, store, provider, socket, gladys };
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
  assert.equal(ranking.items[0].value, '1,599 €/L', 'French reader, French separator');

  const [cheapest, average] = componentsOfType(content, 'value');
  assert.equal(cheapest.value, 1.599);
  assert.equal(average.value, 1.749);

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

test('a tracked fuel is bound to its feature, an untracked one carries the value', async () => {
  const station = createStation({ prices: { gazole: 1.699, sp98: 1.879 } });
  const { context } = contextWith([station]);
  const gladys = createFakeGladys();
  const target = { country: 'FR', stationId: station.id, fuel: 'gazole' };
  gladys.devices = [{ external_id: deviceExternalId(gladys, target), name: 'Ma station' }];

  const content = await getWidgetContent(gladys, context, 'station', {
    settings: { device: deviceExternalId(gladys, target) },
  });

  const tiles = componentsOfType(content, 'value');
  assert.equal(tiles[0].device_feature, `${deviceExternalId(gladys, target)}:price`);
  const sp98 = tiles.find((tile) => tile.label.en === 'SP98');
  assert.equal(sp98.value, 1.879, 'no device for SP98: the feed value is sent');
  assert.equal(sp98.unit, '€/L');
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

test('without SDK support, the widget commands are answered on the socket', async () => {
  // The regression this guards: the SDK ignores an unknown message type in
  // silence, so a core asking for content gets no ack at all and the card
  // reads "data unavailable" after 15 s.
  const { context, socket, gladys } = bridgedGladys([createStation()]);

  assert.equal(
    registerWidgets(gladys, () => context),
    'bridge',
  );

  const ack = await socket.receive({
    type: 'external-integration.widget.get',
    payload: { message_id: 'm1', key: 'best_prices', settings: { fuel: 'gazole' }, language: 'fr' },
  });

  assert.equal(ack.type, 'external-integration.command-result');
  assert.equal(ack.payload.message_id, 'm1');
  assert.equal(ack.payload.success, true);
  assert.equal(ack.payload.data.content.version, 1);
  assert.ok(ack.payload.data.content.components.length > 0);
});

test('a failing widget command is acked as a failure, with its reason', async () => {
  const { socket, gladys, context } = bridgedGladys([]);
  registerWidgets(gladys, () => context);

  const ack = await socket.receive({
    type: 'external-integration.widget.get',
    payload: { message_id: 'm2', key: 'does-not-exist' },
  });

  assert.equal(ack.payload.success, false);
  assert.match(ack.payload.error, /Unknown widget/);
});

test('a widget button is answered with the message shown under it', async () => {
  const { socket, gladys, context } = bridgedGladys([createStation()]);
  registerWidgets(gladys, () => context);

  const ack = await socket.receive({
    type: 'external-integration.widget.action',
    payload: { message_id: 'm3', key: 'best_prices', action_key: 'refresh' },
  });

  assert.equal(ack.payload.success, true);
  assert.ok(ack.payload.data.message.fr);
});

test('the bridge leaves every other message to the SDK', async () => {
  const { socket, gladys, context } = bridgedGladys([]);
  registerWidgets(gladys, () => context);

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'external-integration.device.poll' })));
  socket.emit('message', Buffer.from('not json'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(socket.sent, [], 'nothing was acked on our behalf');
});

test('a reconnection re-attaches the bridge exactly once', () => {
  const { socket, gladys, context } = bridgedGladys([]);
  registerWidgets(gladys, () => context);
  const listeners = socket.listenerCount('message');

  gladys.emit('connected');
  assert.equal(socket.listenerCount('message'), listeners, 'no duplicate listener on one socket');

  const next = createFakeSocket();
  gladys.ws = next;
  gladys.emit('connected');
  assert.equal(next.listenerCount('message'), 1, 'the new socket is bridged');
});

test('every declared widget is registered when the SDK supports them', () => {
  const registered = [];
  const gladys = {
    ...createFakeGladys(),
    onWidgetGet: (key) => registered.push(key),
    onWidgetAction: () => {},
  };

  assert.equal(
    registerWidgets(gladys, () => ({})),
    'sdk',
  );
  assert.deepEqual(registered, WIDGET_KEYS);
  assert.deepEqual(
    buildWidgetManifest().map((widget) => widget.key),
    WIDGET_KEYS,
  );
});

test('the nudge uses the SDK when it has one, and the socket otherwise', () => {
  const nudged = [];
  const withSdk = { ...createFakeGladys(), requestWidgetRefresh: (key) => nudged.push(key) };
  notifyWidgetsChanged(withSdk);
  assert.deepEqual(nudged, WIDGET_KEYS);

  const { socket, gladys } = bridgedGladys([]);
  notifyWidgetsChanged(gladys);
  assert.deepEqual(
    socket.sent.map((message) => message.payload.key),
    WIDGET_KEYS,
  );
  assert.equal(socket.sent[0].type, 'external-integration.widget.refresh');
});

test('a nudge sent while the socket is closed is dropped, never thrown', () => {
  const { socket, gladys } = bridgedGladys([]);
  socket.readyState = 3; // CLOSED

  assert.doesNotThrow(() => notifyWidgetsChanged(gladys));
  assert.deepEqual(socket.sent, []);
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
  assert.equal(curve.series[0].points.length, 1);
  assert.equal(curve.series[0].points[0].v, 1.66);
  assert.equal(
    componentsOfType(content, 'value').some((tile) => tile.unit === 'ct'),
    false,
    'the trend waits for a real week, rather than claiming zero',
  );
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

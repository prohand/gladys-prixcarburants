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

const config = normalizeConfig({ postal_code: '35000', fuel_type: ['gazole', 'sp98'] });

function contextWith(stations) {
  const provider = createFakeProvider({ stations });
  const store = createStationStore({ resolveProvider: () => provider });
  return { context: { config, store }, provider, store };
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

  const [list] = componentsOfType(content, 'card-list');
  assert.deepEqual(
    list.items.map((item) => item.title),
    ['Cheap', 'Pricey'],
  );
  assert.equal(list.items[0].badge.color, 'success');
  assert.equal(list.items[1].badge, undefined);
  assert.match(list.items[0].subtitle, /1,599 €\/L/, 'French reader, French separator');

  const [cheapest, average] = componentsOfType(content, 'value');
  assert.equal(cheapest.value, 1.599);
  assert.equal(average.value, 1.749);
});

test('the ranking honours the number of stations asked for', async () => {
  const stations = Array.from({ length: 6 }, (_, i) =>
    createStation({ id: String(i), name: `S${i}`, prices: { gazole: 1.5 + i / 100 } }),
  );
  const { context } = contextWith(stations);

  const content = await getWidgetContent(createFakeGladys(), context, 'best_prices', {
    settings: { fuel: 'gazole', count: '3' },
  });

  assert.equal(componentsOfType(content, 'card-list')[0].items.length, 3);
});

test('a station with no price for the chosen fuel is left out of the ranking', async () => {
  const { context } = contextWith([createStation({ prices: { gazole: 1.699, gplc: null } })]);

  const content = await getWidgetContent(createFakeGladys(), context, 'best_prices', {
    settings: { fuel: 'gplc' },
  });

  assert.equal(componentsOfType(content, 'card-list').length, 0);
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
    componentsOfType(content, 'card-list')[0].items.map((item) => item.title),
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

test('registration is skipped, not fatal, on an SDK without widget support', () => {
  const gladys = createFakeGladys();
  assert.equal(
    registerWidgets(gladys, () => ({})),
    false,
  );
  // And the nudge is a no-op too: a refresh pass must never fail over it.
  assert.doesNotThrow(() => notifyWidgetsChanged(gladys));
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
    true,
  );
  assert.deepEqual(registered, WIDGET_KEYS);
  assert.deepEqual(
    buildWidgetManifest().map((widget) => widget.key),
    WIDGET_KEYS,
  );
});

test('the nudge asks for one refresh per widget', () => {
  const nudged = [];
  const gladys = { ...createFakeGladys(), requestWidgetRefresh: (key) => nudged.push(key) };

  notifyWidgetsChanged(gladys);

  assert.deepEqual(nudged, WIDGET_KEYS);
});

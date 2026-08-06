// -----------------------------------------------------------------------------
// The France provider parses records coming from a public dataset that is
// mirrored on several portals with slightly different shapes. These tests pin
// down the tolerance: they are the contract the parsing must keep.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { france, parsePrice, parseStation } from '../src/countries/france.js';

test('parsePrice reads a decimal price', () => {
  assert.equal(parsePrice(1.699), 1.699);
  assert.equal(parsePrice('1.699'), 1.699);
  assert.equal(parsePrice('1,699'), 1.699);
});

test('parsePrice converts a price published in thousandths of an euro', () => {
  assert.equal(parsePrice(1699), 1.699);
});

test('parsePrice returns null when there is no price', () => {
  for (const empty of [null, undefined, '', 'N/A', 0, -1]) {
    assert.equal(parsePrice(empty), null, `${JSON.stringify(empty)} should give null`);
  }
});

test('parseStation reads the flat v2 columns', () => {
  const station = parseStation({
    id: '35000001',
    cp: '35000',
    adresse: '1 rue de Nantes',
    ville: 'Rennes',
    marque: 'TotalEnergies',
    latitude: 48.1113,
    longitude: -1.6845,
    gazole_prix: 1.699,
    gazole_maj: '2026-08-06T07:12:00+02:00',
    sp98_prix: 1.879,
  });

  assert.equal(station.id, '35000001');
  assert.equal(station.name, 'TotalEnergies - Rennes');
  assert.equal(station.postalCode, '35000');
  assert.equal(station.prices.gazole, 1.699);
  assert.equal(station.prices.sp98, 1.879);
  assert.equal(station.prices.e85, null, 'a fuel without a column has no price');
  assert.equal(station.updatedAt.gazole, '2026-08-06T07:12:00+02:00');
});

test('parseStation reads the historical nested `prix` array', () => {
  const station = parseStation({
    id: '35000002',
    cp: '35000',
    adresse: '2 rue de Nantes',
    ville: 'Rennes',
    prix: [
      { nom: 'Gazole', valeur: '1.712', maj: '2026-08-06T06:00:00+02:00' },
      { nom: 'E85', valeur: '0.859' },
    ],
  });

  assert.equal(station.prices.gazole, 1.712);
  assert.equal(station.prices.e85, 0.859);
  assert.equal(station.updatedAt.gazole, '2026-08-06T06:00:00+02:00');
});

test('parseStation converts coordinates expressed in hundred-thousandths', () => {
  const station = parseStation({ id: '1', latitude: 4811130, longitude: -168450 });
  assert.ok(Math.abs(station.latitude - 48.1113) < 1e-6);
  assert.ok(Math.abs(station.longitude - -1.6845) < 1e-6);
});

test('parseStation reads a GeoJSON geo point', () => {
  const station = parseStation({
    id: '1',
    geom: { type: 'Point', coordinates: [-1.6845, 48.1113] },
  });
  assert.equal(station.latitude, 48.1113);
  assert.equal(station.longitude, -1.6845);
});

test('parseStation drops the (0, 0) placeholder coordinates', () => {
  const station = parseStation({ id: '1', latitude: 0, longitude: 0 });
  assert.equal(station.latitude, null);
  assert.equal(station.longitude, null);
});

test('parseStation names the station after its brand, whatever the column', () => {
  const columns = ['marque', 'brand', 'enseigne', 'nom_station', 'nom', 'name'];
  for (const column of columns) {
    const station = parseStation({ id: '42', cp: '35000', ville: 'Rennes', [column]: 'Auchan' });
    assert.equal(station.brand, 'Auchan', `${column} should be read as the brand`);
    assert.equal(station.name, 'Auchan - Rennes', `${column} should appear in the name`);
  }
});

test('parseStation skips an empty brand column and keeps looking', () => {
  const station = parseStation({ id: '42', ville: 'Rennes', marque: '  ', enseigne: 'Auchan' });
  assert.equal(station.name, 'Auchan - Rennes');
});

test('parseStation falls back to any column that claims to hold a brand', () => {
  const station = parseStation({ id: '42', ville: 'Rennes', marque_station: 'Auchan' });
  assert.equal(station.brand, 'Auchan');
  assert.equal(station.name, 'Auchan - Rennes');
});

test('parseStation always produces a usable name', () => {
  assert.equal(parseStation({ id: '42', adresse: 'Route de Lorient' }).name, 'Route de Lorient');
  assert.equal(parseStation({ id: '42' }).name, 'Station 42');
  assert.equal(
    parseStation({ id: '42', ville: 'Rennes', adresse: 'Route de Lorient' }).name,
    'Route de Lorient - Rennes',
    'without a brand, the street tells two stations of the same city apart',
  );
});

test('parseStation ignores a record without an id', () => {
  assert.equal(parseStation({ cp: '35000' }), null);
});

test('the France provider validates 5-digit postal codes', () => {
  assert.equal(france.isValidPostalCode('35000'), true);
  assert.equal(france.isValidPostalCode('01000'), true);
  assert.equal(france.isValidPostalCode('3500'), false);
  assert.equal(france.isValidPostalCode('ABCDE'), false);
});

test('searchStations refuses an invalid postal code before any HTTP call', async () => {
  await assert.rejects(
    () => france.searchStations({ postalCode: 'oops' }),
    /Invalid French postal code/,
  );
});

/** Scripted HTTP answers, one per `fetch` call, in order. */
function mockFetch(t, answers) {
  const urls = [];
  let call = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    const answer = answers[Math.min(call++, answers.length - 1)];
    if (answer.status) {
      return { ok: false, status: answer.status, statusText: 'Bad Request' };
    }
    return { ok: true, status: 200, json: async () => ({ results: answer.results }) };
  });
  return urls;
}

test('searchStations widens the search around the postal code', async (t) => {
  const urls = mockFetch(t, [
    { results: [{ id: '1', cp: '35000', ville: 'Rennes', latitude: 48.11, longitude: -1.68 }] },
    {
      results: [
        { id: '1', cp: '35000', ville: 'Rennes', latitude: 48.11, longitude: -1.68 },
        { id: '2', cp: '35135', ville: 'Chantepie', latitude: 48.09, longitude: -1.61 },
      ],
    },
  ]);

  const stations = await france.searchStations({ postalCode: '35000', radiusKm: 10, limit: 20 });

  assert.deepEqual(
    stations.map((s) => s.id),
    ['1', '2'],
    'the postal code station first, then the neighbour, de-duplicated',
  );
  assert.match(urls[0], /where=cp\+%3D\+%2235000%22/);
  assert.match(urls[1], /within_distance/);
});

test('a failing radius search still returns the stations of the postal code', async (t) => {
  mockFetch(t, [
    { results: [{ id: '1', cp: '35000', ville: 'Rennes', latitude: 48.11, longitude: -1.68 }] },
    { status: 400 },
  ]);

  const stations = await france.searchStations({ postalCode: '35000', radiusKm: 10, limit: 20 });

  assert.deepEqual(
    stations.map((s) => s.id),
    ['1'],
  );
});

test('searchStations honours the maximum number of stations', async (t) => {
  const results = Array.from({ length: 5 }, (_, i) => ({
    id: String(i),
    cp: '35000',
    ville: 'Rennes',
    latitude: 48.11 + i / 100,
    longitude: -1.68,
  }));
  mockFetch(t, [{ results }]);

  const stations = await france.searchStations({ postalCode: '35000', radiusKm: 0, limit: 2 });

  assert.equal(stations.length, 2);
});

test('fetchStationsByIds queries the ids it was given', async (t) => {
  const urls = mockFetch(t, [{ results: [{ id: '1', cp: '35000' }] }]);

  await france.fetchStationsByIds(['1', 'oops";DROP']);

  // URLSearchParams encodes spaces as '+'; the quotes injected by a hostile id
  // are stripped by the sanitizer, so the ODSQL literal cannot be escaped.
  const where = decodeURIComponent(urls[0]).replaceAll('+', ' ');
  assert.match(where, /where=id = "1" OR id = "oopsDROP"/);
});

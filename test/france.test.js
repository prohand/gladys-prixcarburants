// -----------------------------------------------------------------------------
// The France provider parses records coming from a public dataset that is
// mirrored on several portals with slightly different shapes. These tests pin
// down the tolerance: they are the contract the parsing must keep.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { france, parsePrice, parseStation } from '../src/countries/france.js';
import { resetGeocodeCache } from '../src/countries/franceGeocode.js';
import { resetRecentFuels } from '../src/countries/franceRecent.js';
import { resetStationNames } from '../src/countries/franceNames.js';

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

/**
 * Scripted HTTP answers, one per `fetch` call, in order; the last one is
 * repeated for every extra call. `results` answers like the price API, `body`
 * lets a test answer like any other endpoint (the geocoder).
 */
function mockFetch(t, answers) {
  const urls = [];
  let call = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    const answer = answers[Math.min(call++, answers.length - 1)];
    if (answer.status) {
      return { ok: false, status: answer.status, statusText: 'Bad Request' };
    }
    const body = 'body' in answer ? answer.body : { results: answer.results };
    return { ok: true, status: 200, json: async () => body };
  });
  return urls;
}

/** The radii, in km, of the `within_distance` circles the search asked for. */
function radiusQueries(urls) {
  return urls
    .filter((url) => url.includes('within_distance'))
    .map((url) => decodeURIComponent(url).match(/([\d.]+)km\)/)[1]);
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

test('searchStations searches around a postal code that has no station of its own', async (t) => {
  resetGeocodeCache();
  const urls = mockFetch(t, [
    // Nothing carries cp = 67750: the feed alone cannot say where it is.
    { results: [] },
    {
      body: {
        features: [
          {
            geometry: { type: 'Point', coordinates: [7.4009, 48.2802] },
            properties: { postcode: '67750', city: 'Scherwiller' },
          },
        ],
      },
    },
    {
      results: [
        {
          id: '67600001',
          cp: '67600',
          ville: 'Sélestat',
          marque: 'Leclerc',
          latitude: 48.26,
          longitude: 7.45,
        },
      ],
    },
  ]);

  const stations = await france.searchStations({ postalCode: '67750', radiusKm: 10, limit: 20 });

  assert.deepEqual(
    stations.map((s) => s.id),
    ['67600001'],
    'the neighbouring station is found even though the postal code has none',
  );
  assert.match(urls[1], /api-adresse\.data\.gouv\.fr/, 'the postal code is geocoded');
  assert.ok(stations[0].distanceKm < 10, 'the distance is measured from the geocoded centre');
});

test('a postal code the geocoder cannot place returns an empty list, not an error', async (t) => {
  resetGeocodeCache();
  mockFetch(t, [{ results: [] }, { status: 500 }]);

  const stations = await france.searchStations({ postalCode: '67750', radiusKm: 10, limit: 20 });

  assert.deepEqual(stations, []);
});

test('the radius search stops on the first complete circle that holds enough stations', async (t) => {
  const around = Array.from({ length: 3 }, (_, i) => ({
    id: `n${i}`,
    cp: '35200',
    ville: 'Rennes',
    marque: 'TotalEnergies',
    latitude: 48.11 + i / 100,
    longitude: -1.68,
  }));
  const urls = mockFetch(t, [
    {
      results: [
        {
          id: '1',
          cp: '35000',
          ville: 'Rennes',
          marque: 'Total',
          latitude: 48.11,
          longitude: -1.68,
        },
      ],
    },
    { results: around },
  ]);

  await france.searchStations({ postalCode: '35000', radiusKm: 40, limit: 3 });

  assert.deepEqual(
    radiusQueries(urls),
    ['5'],
    'a complete 5 km circle already holds the nearest stations: no wider query',
  );
});

test('the radius search widens up to the configured radius when stations are scarce', async (t) => {
  const urls = mockFetch(t, [
    {
      results: [
        {
          id: '1',
          cp: '35000',
          ville: 'Rennes',
          marque: 'Total',
          latitude: 48.11,
          longitude: -1.68,
        },
      ],
    },
    {
      results: [
        {
          id: '2',
          cp: '35135',
          ville: 'Chantepie',
          marque: 'Total',
          latitude: 48.09,
          longitude: -1.61,
        },
      ],
    },
  ]);

  await france.searchStations({ postalCode: '35000', radiusKm: 20, limit: 20 });

  assert.deepEqual(radiusQueries(urls), ['5', '10', '20']);
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

test('parseStation tells a temporary rupture from a fuel the station does not sell', () => {
  const station = parseStation({
    id: '93160006',
    cp: '93160',
    ville: 'Noisy-le-Grand',
    gazole_prix: 2.425,
    sp98_prix: null,
    sp98_rupture_debut: '2026-09-18T08:09:56+00:00',
    sp98_rupture_type: 'temporaire',
    sp95_prix: null,
    sp95_rupture_debut: '2026-07-03T09:22:39+00:00',
    sp95_rupture_type: 'definitive',
  });

  assert.equal(station.availability.gazole, 'available');
  assert.equal(station.availability.sp98, 'out_of_stock', 'the pump exists, the tank is empty');
  assert.equal(station.outOfStockSince.sp98, '2026-09-18T08:09:56+00:00');
  assert.equal(station.availability.sp95, 'not_sold', 'a definitive rupture is a pump that closed');
  assert.equal(station.outOfStockSince.sp95, null);
  assert.equal(station.availability.e85, 'not_sold', 'no column, no rupture: never sold there');
});

test('parseStation reads the ruptures of the historical nested array', () => {
  const station = parseStation({
    id: '35000003',
    cp: '35000',
    rupture: JSON.stringify([
      // The feed keeps the old declarations: only the most recent one describes
      // the station today.
      { '@nom': 'SP98', '@debut': '2016-05-26 05:00:00', '@fin': '', '@type': 'definitive' },
      { '@nom': 'SP98', '@debut': '2026-09-18 08:09:56', '@fin': '', '@type': 'temporaire' },
      { '@nom': 'E85', '@debut': '2026-09-01 10:00:00', '@fin': '', '@type': '' },
      { '@nom': 'GPLc', '@debut': '2026-09-01 10:00:00', '@fin': '2026-09-10 10:00:00' },
    ]),
  });

  assert.equal(station.availability.sp98, 'out_of_stock');
  assert.equal(station.outOfStockSince.sp98, '2026-09-18 08:09:56');
  assert.equal(station.availability.e85, 'out_of_stock', 'an unqualified rupture is temporary');
  assert.equal(station.availability.gplc, 'not_sold', 'a rupture that ended says nothing today');
});

test('parseStation trusts a published price over a rupture the feed still carries', () => {
  const station = parseStation({
    id: '35000004',
    cp: '35000',
    gazole_prix: 1.699,
    gazole_rupture_debut: '2026-09-01T10:00:00+00:00',
    gazole_rupture_type: 'temporaire',
  });

  assert.equal(station.availability.gazole, 'available');
  assert.equal(station.outOfStockSince.gazole, null);
});

// Reported on 104/106 av. Médéric, Noisy-le-Grand: the SP98 rupture was lifted
// but no price typed back, so the feed carried nothing at all for SP98.
const MEDERIC = {
  id: '93160009',
  cp: '93160',
  ville: 'Noisy-le-Grand',
  adresse: '104/106 AV MEDERIC',
  marque: 'TotalEnergies',
  gazole_prix: 2.25,
  sp95_rupture_debut: '2020-11-10T14:12:05+00:00',
  sp95_rupture_type: 'definitive',
};

test('a fuel the feed is silent about but the station priced recently is out of stock', async (t) => {
  resetRecentFuels();
  const urls = mockFetch(t, [
    { results: [MEDERIC] },
    // The history: SP98 and SP95 priced within the window, E85 never.
    { results: [{ id: '93160009', gazole: 2.25, sp98: 1.99, sp95: 1.9, e85: null }] },
  ]);

  const [station] = await france.fetchStationsByIds(['93160009']);

  assert.match(urls[1], /prix-des-carburants-j-1/, 'the history is asked');
  assert.equal(station.availability.sp98, 'out_of_stock', 'a pump waiting for its price');
  assert.equal(station.outOfStockSince.sp98, null, 'the feed declared no date');
  assert.equal(station.availability.sp95, 'not_sold', 'a definitive rupture is never questioned');
  assert.equal(station.availability.e85, 'not_sold', 'never priced: still not sold');
  assert.equal(station.availability.gazole, 'available');
});

test('the price history is cached between two refreshes', async (t) => {
  resetRecentFuels();
  const urls = mockFetch(t, [
    { results: [MEDERIC] },
    { results: [{ id: '93160009', sp98: 1.99 }] },
    { results: [MEDERIC] },
  ]);

  await france.fetchStationsByIds(['93160009']);
  const [station] = await france.fetchStationsByIds(['93160009']);

  assert.equal(urls.filter((url) => url.includes('prix-des-carburants-j-1')).length, 1);
  assert.equal(station.availability.sp98, 'out_of_stock', 'the cached answer still applies');
});

test('an unreachable price history leaves the reading of the feed unchanged', async (t) => {
  resetRecentFuels();
  mockFetch(t, [{ results: [MEDERIC] }, { status: 500 }]);

  const [station] = await france.fetchStationsByIds(['93160009']);

  assert.equal(station.availability.sp98, 'not_sold');
  assert.equal(station.availability.gazole, 'available');
});

test('a station the feed fully qualifies costs no history request', async (t) => {
  resetRecentFuels();
  resetStationNames();
  const qualified = { ...MEDERIC };
  for (const fuel of ['sp98', 'e10', 'e85', 'gplc']) {
    qualified[`${fuel}_rupture_debut`] = '2020-01-01T00:00:00+00:00';
    qualified[`${fuel}_rupture_type`] = 'definitive';
  }
  const urls = mockFetch(t, [{ results: [qualified] }]);

  await france.fetchStationsByIds(['93160009']);

  assert.equal(urls.filter((url) => url.includes('prix-des-carburants-j-1')).length, 0);
});

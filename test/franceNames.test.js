// -----------------------------------------------------------------------------
// The national price feed carries no station name, so the name is fetched from
// a reference dataset. These tests pin down the two things that matter: the
// name reaches the station, and nothing about it can cost the user their prices.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStationName,
  resetStationNames,
  resolveStationNames,
} from '../src/countries/franceNames.js';

/** A station as the price feed publishes it: an address, and no name. */
function nameless(id = '69100004') {
  return {
    id,
    brand: '',
    city: 'Oullins-Pierre-Bénite',
    address: '141 Boulevard Émile Zola',
    name: '141 Boulevard Émile Zola - Oullins-Pierre-Bénite',
  };
}

/**
 * Mock the reference dataset: `sample` answers the one-record probe, `records`
 * answer the id lookup. Returns the URLs that were requested.
 */
function mockReference(t, { sample, records = [], status }) {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    if (status) {
      return { ok: false, status, statusText: 'Bad Request' };
    }
    const results = url.searchParams.get('where') ? records : [sample].filter(Boolean);
    return { ok: true, status: 200, json: async () => ({ results }) };
  });
  return urls;
}

test('a station with no brand is named after the reference dataset', async (t) => {
  resetStationNames();
  mockReference(t, {
    sample: { id: '35000001', nom: 'RELAIS DE LA GARE', marque: 'TotalEnergies', ville: 'Rennes' },
    records: [{ id: '69100004', nom: 'STATION OULLINS', marque: 'Total Access' }],
  });

  const stations = [nameless()];
  await resolveStationNames(stations);

  assert.equal(stations[0].brand, 'Total Access');
  assert.equal(stations[0].name, 'Total Access - Oullins-Pierre-Bénite');
});

test('an independent station falls back on its commercial name', async (t) => {
  resetStationNames();
  mockReference(t, {
    sample: { id: '35000001', nom: 'RELAIS DE LA GARE', marque: 'TotalEnergies' },
    records: [{ id: '69100004', nom: 'Garage Dupont', marque: '  ' }],
  });

  const stations = [nameless()];
  await resolveStationNames(stations);

  assert.equal(stations[0].name, 'Garage Dupont - Oullins-Pierre-Bénite');
});

test('the id is quoted according to the type the reference dataset uses', async (t) => {
  resetStationNames();
  const urls = mockReference(t, {
    sample: { id: 35000001, marque: 'TotalEnergies' },
    records: [{ id: 69100004, marque: 'Total Access' }],
  });

  const stations = [nameless()];
  await resolveStationNames(stations);

  assert.equal(urls[1].searchParams.get('where'), 'id = 69100004', 'a numeric id is not quoted');
  assert.equal(stations[0].brand, 'Total Access', 'a numeric id still matches our string id');
});

test('a station already carrying a brand costs no lookup', async (t) => {
  resetStationNames();
  const urls = mockReference(t, { sample: { id: '1', marque: 'TotalEnergies' } });

  const stations = [{ ...nameless(), brand: 'Auchan' }];
  await resolveStationNames(stations);

  assert.deepEqual(urls, [], 'a mirror that publishes the brand is enough');
  assert.equal(stations[0].name, 'Auchan - Oullins-Pierre-Bénite');
});

test('a name is fetched once, then served from the cache', async (t) => {
  resetStationNames();
  const urls = mockReference(t, {
    sample: { id: '35000001', marque: 'TotalEnergies' },
    records: [{ id: '69100004', marque: 'Total Access' }],
  });

  await resolveStationNames([nameless()]);
  const afterFirstPass = urls.length;
  const stations = [nameless()];
  await resolveStationNames(stations);

  assert.equal(urls.length, afterFirstPass, 'refreshing a price re-queries nothing');
  assert.equal(stations[0].brand, 'Total Access');
});

test('a station the reference dataset ignores is not asked for twice', async (t) => {
  resetStationNames();
  const urls = mockReference(t, {
    sample: { id: '35000001', marque: 'TotalEnergies' },
    records: [],
  });

  await resolveStationNames([nameless()]);
  const afterFirstPass = urls.length;
  const stations = [nameless()];
  await resolveStationNames(stations);

  assert.equal(urls.length, afterFirstPass);
  assert.equal(
    stations[0].name,
    '141 Boulevard Émile Zola - Oullins-Pierre-Bénite',
    'the address stays the name when nothing better exists',
  );
});

test('an unreachable reference dataset leaves the stations usable', async (t) => {
  resetStationNames();
  mockReference(t, { status: 500 });

  const stations = [nameless()];
  await resolveStationNames(stations);

  assert.equal(stations[0].name, '141 Boulevard Émile Zola - Oullins-Pierre-Bénite');
});

test('a reference dataset without a name column is not used', async (t) => {
  resetStationNames();
  mockReference(t, { sample: { id: '35000001', cp: '35000', ville: 'Rennes' } });

  const stations = [nameless()];
  await resolveStationNames(stations);

  assert.equal(stations[0].brand, '');
  assert.equal(stations[0].name, '141 Boulevard Émile Zola - Oullins-Pierre-Bénite');
});

test('buildStationName always produces something recognisable', () => {
  assert.equal(buildStationName({ id: '42', brand: 'Auchan', city: 'Rennes' }), 'Auchan - Rennes');
  assert.equal(
    buildStationName({ id: '42', address: 'Route de Lorient', city: 'Rennes' }),
    'Route de Lorient - Rennes',
  );
  assert.equal(buildStationName({ id: '42' }), 'Station 42');
});

test('two stations of the same brand in the same city get their street back', async (t) => {
  resetStationNames();
  mockReference(t, { sample: { id: '35000001', marque: 'TotalEnergies' }, records: [] });

  const stations = [
    {
      id: '93160001',
      brand: 'TotalEnergies',
      city: 'Noisy-le-Grand',
      address: '33 Avenue Médéric',
      name: '',
    },
    {
      id: '93160009',
      brand: 'TotalEnergies',
      city: 'Noisy-le-Grand',
      address: '104/106 AV MEDERIC',
      name: '',
    },
    { id: '93160002', brand: 'Esso', city: 'Noisy-le-Grand', address: '2 Rue du Pont', name: '' },
  ];
  await resolveStationNames(stations);

  assert.equal(stations[0].name, 'TotalEnergies - 33 Av. Médéric - Noisy-le-Grand');
  assert.equal(stations[1].name, 'TotalEnergies - 104/106 AV MEDERIC - Noisy-le-Grand');
  // The only Esso of the city keeps the short name: disambiguating costs
  // nothing to the stations that are already unique.
  assert.equal(stations[2].name, 'Esso - Noisy-le-Grand');
});

test('stations sharing a brand, a city AND an address fall back on their id', async (t) => {
  resetStationNames();
  mockReference(t, { sample: { id: '35000001', marque: 'TotalEnergies' }, records: [] });

  const stations = [
    {
      id: '77410001',
      brand: 'Total',
      city: 'Claye-Souilly',
      address: 'A4 Aire de Vémars',
      name: '',
    },
    {
      id: '77410002',
      brand: 'Total',
      city: 'Claye-Souilly',
      address: 'A4 Aire de Vémars',
      name: '',
    },
  ];
  await resolveStationNames(stations);

  assert.equal(stations[0].name, 'Total - A4 Aire de Vémars - Claye-Souilly (77410001)');
  assert.equal(stations[1].name, 'Total - A4 Aire de Vémars - Claye-Souilly (77410002)');
});

test('a nameless station keeps its address-based name instead of repeating it', async (t) => {
  resetStationNames();
  mockReference(t, { sample: { id: '35000001', marque: 'TotalEnergies' }, records: [] });

  const stations = [
    { id: '69100004', brand: '', city: 'Oullins', address: 'Boulevard Émile Zola', name: '' },
    { id: '69100005', brand: '', city: 'Oullins', address: 'Boulevard Émile Zola', name: '' },
  ];
  await resolveStationNames(stations);

  assert.equal(stations[0].name, 'Boulevard Émile Zola - Oullins (69100004)');
  assert.equal(stations[1].name, 'Boulevard Émile Zola - Oullins (69100005)');
});

// -----------------------------------------------------------------------------
// Locating a postal code is what makes the radius search possible for the ones
// the price feed knows no station in. It is best effort: these tests pin down
// that it never throws, and that it never costs a request twice.
// -----------------------------------------------------------------------------

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { geocodePostalCode, resetGeocodeCache } from '../src/countries/franceGeocode.js';

beforeEach(() => resetGeocodeCache());

/** Answers every call with the same GeoJSON body, and counts the calls. */
function mockGeocoder(t, features) {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ type: 'FeatureCollection', features }) };
  });
  return urls;
}

const scherwiller = {
  geometry: { type: 'Point', coordinates: [7.4009, 48.2802] },
  properties: { postcode: '67750', city: 'Scherwiller', type: 'municipality' },
};
const dieffenthal = {
  geometry: { type: 'Point', coordinates: [7.4209, 48.2602] },
  properties: { postcode: '67750', city: 'Dieffenthal', type: 'municipality' },
};

test('geocodePostalCode averages the communes sharing the postal code', async (t) => {
  const urls = mockGeocoder(t, [scherwiller, dieffenthal]);

  const centre = await geocodePostalCode('67750');

  assert.ok(Math.abs(centre.latitude - 48.2702) < 1e-6);
  assert.ok(Math.abs(centre.longitude - 7.4109) < 1e-6);
  assert.match(urls[0], /q=67750/);
  assert.match(urls[0], /type=municipality/);
});

test('geocodePostalCode ignores the results carrying another postal code', async (t) => {
  mockGeocoder(t, [
    {
      geometry: { type: 'Point', coordinates: [2.3522, 48.8566] },
      properties: { postcode: '75001', city: 'Paris' },
    },
    scherwiller,
  ]);

  const centre = await geocodePostalCode('67750');

  assert.ok(Math.abs(centre.latitude - 48.2802) < 1e-6, 'only the 67750 commune counts');
});

test('geocodePostalCode falls back to the best match when none carries the postal code', async (t) => {
  mockGeocoder(t, [
    { geometry: { type: 'Point', coordinates: [7.4009, 48.2802] }, properties: {} },
    { geometry: { type: 'Point', coordinates: [2.3522, 48.8566] }, properties: {} },
  ]);

  const centre = await geocodePostalCode('67750');

  assert.ok(Math.abs(centre.latitude - 48.2802) < 1e-6);
});

test('geocodePostalCode asks only once per postal code', async (t) => {
  const urls = mockGeocoder(t, [scherwiller]);

  await geocodePostalCode('67750');
  await geocodePostalCode('67750');

  assert.equal(urls.length, 1, 'a commune does not move: the answer is cached');
});

test('geocodePostalCode remembers a postal code the geocoder does not know', async (t) => {
  const urls = mockGeocoder(t, []);

  assert.equal(await geocodePostalCode('99999'), null);
  assert.equal(await geocodePostalCode('99999'), null);
  assert.equal(urls.length, 1);
});

test('geocodePostalCode returns null when the geocoder fails, and retries later', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, status: 503, statusText: 'Service Unavailable' };
    }
    return { ok: true, status: 200, json: async () => ({ features: [scherwiller] }) };
  });

  assert.equal(await geocodePostalCode('67750'), null, 'a failure is never thrown at the caller');
  assert.ok(await geocodePostalCode('67750'), 'a failure is not cached: the next search retries');
});

test('geocodePostalCode does not call the geocoder for a malformed postal code', async (t) => {
  const urls = mockGeocoder(t, [scherwiller]);

  assert.equal(await geocodePostalCode('oops'), null);
  assert.equal(await geocodePostalCode(''), null);
  assert.equal(await geocodePostalCode(undefined), null);
  assert.equal(urls.length, 0);
});

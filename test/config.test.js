import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, isConfigReady, normalizeConfig } from '../src/config.js';

test('normalizeConfig returns the defaults when nothing is configured', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig forces the types coming from the form', () => {
  const config = normalizeConfig({
    postal_code: ' 35000 ',
    search_radius_km: '15',
    max_stations: '5',
    poll_frequency: '1800',
  });
  assert.equal(config.postal_code, '35000');
  assert.equal(config.search_radius_km, 15);
  assert.equal(config.max_stations, 5);
  assert.equal(config.poll_frequency, 1800);
});

test('normalizeConfig keeps the leading zero of a postal code', () => {
  assert.equal(normalizeConfig({ postal_code: '01000' }).postal_code, '01000');
});

test('normalizeConfig clamps out-of-range numbers instead of trusting them', () => {
  const config = normalizeConfig({ search_radius_km: 900, poll_frequency: 1, max_stations: 999 });
  assert.equal(config.search_radius_km, 50);
  assert.equal(config.poll_frequency, 600);
  assert.equal(config.max_stations, 50);
});

test('normalizeConfig ignores a non numeric value', () => {
  assert.equal(normalizeConfig({ poll_frequency: 'often' }).poll_frequency, 3600);
});

test('normalizeConfig falls back to the default country for an unknown one', () => {
  assert.equal(normalizeConfig({ country: 'ZZ' }).country, 'FR');
  assert.equal(normalizeConfig({ country: 'fr' }).country, 'FR');
});

test('normalizeConfig keeps only known fuels, in catalog order', () => {
  const config = normalizeConfig({ fuel_type: ['sp98', 'unobtainium', 'gazole'] });
  assert.deepEqual(config.fuel_type, ['gazole', 'sp98']);
});

test('normalizeConfig never leaves the fuel selection empty', () => {
  assert.deepEqual(normalizeConfig({ fuel_type: [] }).fuel_type, ['gazole']);
  assert.deepEqual(normalizeConfig({ fuel_type: ['nope'] }).fuel_type, ['gazole']);
});

test('normalizeConfig accepts a single fuel sent as a string', () => {
  assert.deepEqual(normalizeConfig({ fuel_type: 'e85' }).fuel_type, ['e85']);
});

test('isConfigReady requires a postal code', () => {
  assert.equal(isConfigReady(normalizeConfig()), false);
  assert.equal(isConfigReady(normalizeConfig({ postal_code: '35000' })), true);
});

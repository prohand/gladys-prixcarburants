import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centroid, distanceKm, isValidPoint } from '../src/geo.js';

const rennes = { latitude: 48.1113, longitude: -1.6845 };
const nantes = { latitude: 47.2184, longitude: -1.5536 };

test('distanceKm matches the real distance between two cities', () => {
  // Rennes -> Nantes is about 100 km as the crow flies.
  const distance = distanceKm(rennes, nantes);
  assert.ok(distance > 98 && distance < 102, `got ${distance} km`);
});

test('distanceKm is null when a point has no coordinates', () => {
  assert.equal(distanceKm(rennes, { latitude: null, longitude: null }), null);
});

test('isValidPoint rejects the (0, 0) placeholder and out-of-range values', () => {
  assert.equal(isValidPoint(rennes), true);
  assert.equal(isValidPoint({ latitude: 0, longitude: 0 }), false);
  assert.equal(isValidPoint({ latitude: 950, longitude: 12 }), false);
  assert.equal(isValidPoint(null), false);
});

test('centroid averages the valid points and ignores the others', () => {
  const center = centroid([rennes, nantes, { latitude: null, longitude: null }]);
  assert.ok(Math.abs(center.latitude - (rennes.latitude + nantes.latitude) / 2) < 1e-9);
  assert.ok(Math.abs(center.longitude - (rennes.longitude + nantes.longitude) / 2) < 1e-9);
});

test('centroid returns null when nothing is locatable', () => {
  assert.equal(centroid([{ latitude: 0, longitude: 0 }]), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, formatDateTime } from '../src/text.js';

test('cleanText collapses the whitespace of an open data column', () => {
  assert.equal(cleanText('  1   rue de\tNantes  '), '1 rue de Nantes');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(undefined), '');
});

test('formatDateTime shortens the ISO timestamp of the feed', () => {
  assert.equal(formatDateTime('2026-08-06T07:12:00+02:00'), '2026-08-06 07:12');
  assert.equal(formatDateTime('2026-08-06 07:12:00'), '2026-08-06 07:12');
  assert.equal(formatDateTime('2026-08-06T07:12'), '2026-08-06 07:12');
});

test('formatDateTime keeps the declared wall-clock time, not the container one', () => {
  // Parsing this as a Date would re-express it in the container timezone (UTC
  // in the Gladys sandbox) and claim the price was declared at 22:30 the day
  // before. The time the driver read on the roadside sign is 00:30.
  assert.equal(formatDateTime('2026-08-06T00:30:00+02:00'), '2026-08-06 00:30');
});

test('formatDateTime falls back to the raw value it cannot read', () => {
  // A publisher changing the column format must not blank the feature out.
  assert.equal(formatDateTime('06/08/2026 07:12'), '06/08/2026 07:12');
  assert.equal(formatDateTime(''), '');
  assert.equal(formatDateTime(null), '');
  assert.equal(formatDateTime(undefined), '');
});

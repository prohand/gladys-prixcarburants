import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText,
  displayTimeZone,
  formatDateTime,
  formatInstant,
  shortenAddress,
  startOfZonedDay,
  zonedParts,
} from '../src/text.js';

test('cleanText collapses the whitespace of an open data column', () => {
  assert.equal(cleanText('  1   rue de\tNantes  '), '1 rue de Nantes');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(undefined), '');
});

test('formatDateTime shortens the ISO timestamp of the feed', () => {
  assert.equal(formatDateTime('2026-08-06T07:12:00+02:00'), '06/08/2026 à 07:12');
  assert.equal(formatDateTime('2026-08-06 07:12:00'), '06/08/2026 à 07:12');
  assert.equal(formatDateTime('2026-08-06T07:12'), '06/08/2026 à 07:12');
});

test('formatDateTime keeps the declared wall-clock time, not the container one', () => {
  // Parsing this as a Date would re-express it in the container timezone (UTC
  // in the Gladys sandbox) and claim the price was declared at 22:30 the day
  // before. The time the driver read on the roadside sign is 00:30.
  assert.equal(formatDateTime('2026-08-06T00:30:00+02:00'), '06/08/2026 à 00:30');
});

test('formatInstant displays an observed instant on the Paris clock, not the container one', () => {
  // A moment WE observed, shown in the timezone the user reads their dashboard
  // in. The sandbox sets no TZ, so the container's own clock is UTC: a read at
  // 11:00 in Paris used to be dated 09:00.
  const paris = { timeZone: 'Europe/Paris' };
  assert.equal(formatInstant(Date.UTC(2026, 7, 8, 19, 0), paris), '08/08/2026 à 21:00', 'summer');
  assert.equal(formatInstant(new Date(Date.UTC(2026, 0, 3, 8, 5)), paris), '03/01/2026 à 09:05');
  assert.equal(
    formatInstant(Date.UTC(2026, 7, 8, 22, 30), paris),
    '09/08/2026 à 00:30',
    'next day',
  );
  // The default is that same zone, whatever the container runs in.
  if (!process.env.TZ) {
    assert.equal(formatInstant(Date.UTC(2026, 7, 8, 19, 0)), '08/08/2026 à 21:00');
  }
});

test('TZ overrides the display zone only when it names a real one', () => {
  assert.equal(displayTimeZone({}), 'Europe/Paris');
  assert.equal(displayTimeZone({ TZ: '' }), 'Europe/Paris');
  assert.equal(displayTimeZone({ TZ: 'America/Martinique' }), 'America/Martinique');
  assert.equal(displayTimeZone({ TZ: 'Mars/Olympus' }), 'Europe/Paris', 'a typo falls back');
  assert.equal(displayTimeZone({ TZ: ':/etc/localtime' }), 'Europe/Paris');
  assert.equal(
    formatInstant(Date.UTC(2026, 7, 8, 19, 0), { timeZone: 'America/Martinique' }),
    '08/08/2026 à 15:00',
  );
});

test('startOfZonedDay is the local midnight, summer time changes included', () => {
  const paris = 'Europe/Paris';
  // 09:30 in Paris (UTC+2) opened at 22:00 UTC the day before.
  assert.equal(
    startOfZonedDay(Date.UTC(2026, 8, 22, 7, 30), paris).toISOString(),
    '2026-09-21T22:00:00.000Z',
  );
  // 25 October 2026: the clocks go back at 03:00, the day opened at UTC+2.
  assert.equal(
    startOfZonedDay(Date.UTC(2026, 9, 25, 20, 0), paris).toISOString(),
    '2026-10-24T22:00:00.000Z',
  );
  // 29 March 2026: the clocks go forward at 02:00, the day opened at UTC+1.
  assert.equal(
    startOfZonedDay(Date.UTC(2026, 2, 29, 20, 0), paris).toISOString(),
    '2026-03-28T23:00:00.000Z',
  );
  assert.deepEqual(zonedParts(Date.UTC(2026, 2, 29, 20, 0), paris), {
    year: 2026,
    month: 3,
    day: 29,
    hours: 22,
    minutes: 0,
  });
});

test('formatInstant has nothing to show before the first successful read', () => {
  assert.equal(formatInstant(null), '');
  assert.equal(formatInstant(undefined), '');
  assert.equal(formatInstant(new Date('nope')), '');
});

test('formatDateTime falls back to the raw value it cannot read', () => {
  // A publisher changing the column format must not blank the feature out.
  assert.equal(formatDateTime('06/08/2026 07:12'), '06/08/2026 07:12');
  assert.equal(formatDateTime(''), '');
  assert.equal(formatDateTime(null), '');
  assert.equal(formatDateTime(undefined), '');
});

test('shortenAddress abbreviates the street type and keeps the number', () => {
  assert.equal(shortenAddress('33 Avenue Médéric'), '33 Av. Médéric');
  assert.equal(shortenAddress('141  Boulevard Émile Zola '), '141 Bd Émile Zola');
  assert.equal(shortenAddress('Route de Paris'), 'Rte de Paris');
  assert.equal(shortenAddress('ZONE INDUSTRIELLE DU BOIS'), 'ZA DU BOIS');
});

test('shortenAddress cuts a very long street on a word boundary', () => {
  const short = shortenAddress('12 Avenue du Général Charles de Gaulle et des Alliés');
  assert.ok(short.length <= 29, `too long: ${short}`);
  assert.ok(short.endsWith('…'));
  assert.ok(short.startsWith('12 Av. du Général'));
});

test('shortenAddress has nothing to say about a missing address', () => {
  assert.equal(shortenAddress(''), '');
  assert.equal(shortenAddress(null), '');
  assert.equal(shortenAddress(undefined), '');
});

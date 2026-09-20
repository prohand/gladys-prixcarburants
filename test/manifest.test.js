// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers, nor which fuels and countries it
// really supports — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ACTIONS } from '../src/actions.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { COUNTRIES } from '../src/countries/index.js';
import { FUEL_KEYS } from '../src/fuels.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const field = (key) => manifest.config_schema.find((f) => f.key === key);

test('every manifest action has a registered handler', () => {
  for (const action of manifest.actions ?? []) {
    assert.ok(ACTIONS[action.key], `manifest action "${action.key}" has no handler`);
  }
});

test('every registered handler is declared in the manifest', () => {
  const declared = new Set((manifest.actions ?? []).map((a) => a.key));
  for (const key of Object.keys(ACTIONS)) {
    assert.ok(declared.has(key), `handler "${key}" is missing from the manifest`);
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const f of manifest.config_schema) {
    if (f.default !== undefined) {
      assert.deepEqual(
        DEFAULT_CONFIG[f.key],
        f.default,
        `DEFAULT_CONFIG.${f.key} must match the manifest default`,
      );
    }
  }
});

test('the country select offers exactly the countries the code implements', () => {
  assert.deepEqual(
    field('country')
      .options.map((o) => o.value)
      .sort(),
    Object.keys(COUNTRIES).sort(),
  );
});

test('the fuel select offers exactly the fuels of the catalog', () => {
  assert.deepEqual(
    field('fuel_type').options.map((o) => o.value),
    FUEL_KEYS,
  );
});

test('every select option is labelled in both languages', () => {
  for (const f of manifest.config_schema) {
    for (const option of f.options ?? []) {
      assert.ok(option.label?.en, `option "${option.value}" needs an English label`);
      assert.ok(option.label?.fr, `option "${option.value}" needs a French label`);
    }
  }
});

test('the numeric bounds of the manifest match the ones normalizeConfig applies', () => {
  // Both exist on purpose: the form prevents the mistake, normalizeConfig
  // protects the code from a value that reached the config another way.
  const bounds = {
    search_radius_km: [0, 50],
    max_stations: [1, 50],
    poll_frequency: [600, 86400],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    assert.equal(field(key).min, min, `${key} min`);
    assert.equal(field(key).max, max, `${key} max`);
  }
});

test('the postal code is required, since nothing can be searched without it', () => {
  assert.equal(field('postal_code').required, true);
  assert.equal(field('postal_code').default, undefined, 'no country-neutral default exists');
});

test('the catalog categories stay within what Gladys knows, and require 4.86', () => {
  // The store shelves the integration under these keys; without them it only
  // appears under "All" and in the search. The field itself only exists since
  // Gladys 4.86 — an older core rejects a manifest carrying unknown fields, so
  // declaring `categories` and raising `gladys_version` go together.
  const KNOWN = [
    'climate',
    'lighting',
    'energy',
    'security',
    'multimedia',
    'appliances',
    'environment',
    'protocols',
    'network',
    'notifications',
    'assistants',
    'services',
  ];
  assert.ok(Array.isArray(manifest.categories), 'categories must be an array');
  assert.ok(
    manifest.categories.length >= 1 && manifest.categories.length <= 3,
    'between 1 and 3 categories are allowed',
  );
  for (const category of manifest.categories) {
    assert.ok(KNOWN.includes(category), `unknown catalog category "${category}"`);
  }
  const minimum = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\./);
  assert.ok(minimum, 'gladys_version must declare a minimum version');
  const [, major, minor] = minimum.map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('the manifest declares the transport the integration really uses', () => {
  // The Local/Cloud tag of the store catalog is read from this field: without
  // it the card carries neither, and the "Cloud" facet of the catalog does not
  // list the integration. Every price comes from a national open data API over
  // the internet, so `cloud` is the whole truth here — declaring `local` too
  // would add the core's "Prefer local (LAN) connection" toggle to a config
  // screen where it means nothing.
  assert.deepEqual(manifest.transports, ['cloud']);
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0);
  for (const section of sections) {
    // A section stores NO value: declaring `required`, `default` or
    // `placeholder` on it rejects the manifest, and its key must never leak
    // into the config the code manipulates.
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(section.placeholder, undefined, `section "${section.key}" has no placeholder`);
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(!(section.key in DEFAULT_CONFIG), `section "${section.key}" stores no value`);
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

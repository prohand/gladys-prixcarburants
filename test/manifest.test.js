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
import { WIDGET_KEYS, buildWidgetManifest } from '../src/widgets/index.js';

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

// --- Dashboard widgets -------------------------------------------------------
// The `widgets` field declares the IDENTITY of the cards (key, label, icon,
// per-instance settings); their content is built at runtime by src/widgets/.
// The declarations live in the code, so the manifest is only ever a copy — and
// these tests are what makes sure it is still the right one.

test('the manifest declares exactly the widgets the code implements', () => {
  assert.deepEqual(manifest.widgets, buildWidgetManifest());
});

test('every widget key is registered, and every registered key is declared', () => {
  const declared = (manifest.widgets ?? []).map((w) => w.key);
  assert.deepEqual(declared.sort(), [...WIDGET_KEYS].sort());
});

test('widget declarations stay within the bounds the core validates', () => {
  // Rejections here are manifest-wide: a single out-of-bounds label makes
  // Gladys refuse the WHOLE integration, not just the widget.
  assert.ok(manifest.widgets.length <= 5, 'at most 5 widgets per manifest');
  const seen = new Set();
  for (const widget of manifest.widgets) {
    assert.match(widget.key, /^[a-z0-9_]{2,32}$/, `widget key "${widget.key}"`);
    assert.ok(!seen.has(widget.key), `duplicate widget key "${widget.key}"`);
    seen.add(widget.key);

    for (const [lang, label] of Object.entries(widget.label)) {
      assert.ok(
        label.length >= 3 && label.length <= 30,
        `widget "${widget.key}" ${lang} label must be 3-30 characters`,
      );
    }
    assert.ok(widget.label.en && widget.label.fr, `widget "${widget.key}" needs both languages`);
    for (const [lang, description] of Object.entries(widget.description ?? {})) {
      assert.ok(description.length <= 100, `widget "${widget.key}" ${lang} description ≤ 100`);
    }
    if (widget.icon !== undefined) {
      assert.match(widget.icon, /^[a-z0-9-]{1,40}$/, `widget "${widget.key}" icon`);
    }
    assert.ok(
      widget.action_timeout_seconds >= 5 && widget.action_timeout_seconds <= 120,
      `widget "${widget.key}" action timeout must be 5-120s`,
    );
  }
});

test('widget settings use the restricted config_schema grammar', () => {
  // `secret`, `oauth2` and `account_link` are refused: widget settings live in
  // the dashboard JSON, which every user of a shared dashboard can read.
  const ALLOWED = ['string', 'number', 'boolean', 'select', 'multi_select', 'section'];
  for (const widget of manifest.widgets) {
    const settings = widget.settings ?? [];
    assert.ok(settings.length <= 10, `widget "${widget.key}" declares at most 10 settings`);
    for (const setting of settings) {
      assert.ok(
        ALLOWED.includes(setting.type),
        `setting "${setting.key}" has type ${setting.type}`,
      );
      assert.ok(setting.label?.en, `setting "${setting.key}" needs an English label`);
      assert.ok(setting.label?.fr, `setting "${setting.key}" needs a French label`);
      for (const option of setting.options ?? []) {
        assert.ok(
          option.label?.en && option.label?.fr,
          `option "${option.value}" needs both labels`,
        );
      }
      if (setting.source !== undefined) {
        assert.equal(setting.source, 'devices', 'the only dynamic source a widget may use');
      }
      assert.ok(
        !JSON.stringify(setting).includes('{{port:'),
        `setting "${setting.key}" must not use a {{port:…}} placeholder`,
      );
    }
  }
});

test('the fuel setting of the ranking offers exactly the fuels of the catalog', () => {
  const widget = manifest.widgets.find((w) => w.key === 'best_prices');
  const fuel = widget.settings.find((s) => s.key === 'fuel');
  assert.deepEqual(
    fuel.options.map((o) => o.value),
    FUEL_KEYS,
  );
  assert.ok(FUEL_KEYS.includes(fuel.default), 'the default fuel must exist in the catalog');
});

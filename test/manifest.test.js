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
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';
import { COUNTRIES } from '../src/countries/index.js';
import { FUEL_KEYS } from '../src/fuels.js';
import { WIDGET_KEYS, buildWidgetManifest } from '../src/widgets/index.js';
import { FEED_STATUSES, PRICE_DIRECTIONS, SCENE_TRIGGER_CONTRACT } from '../src/sceneEvents.js';
import { REPORT_LIMITS, SCENE_ACTIONS, SCENE_ACTION_CONTRACT } from '../src/sceneActions.js';

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

test('the fields that came with Gladys 5.1 require 5.1 in gladys_version', () => {
  // Same rule as `categories` above, one release later: `widgets`,
  // `scene_triggers` and `scene_actions` ship with Gladys 5.1
  // (GladysAssistant/Gladys#3109 and #3110), and a core that predates them
  // rejects the WHOLE manifest as carrying unknown fields. The store indexer
  // refuses the pair outright, so the two move together or not at all.
  const FIELDS_OF_5_1 = ['widgets', 'scene_triggers', 'scene_actions'];
  const declared = FIELDS_OF_5_1.filter((field) => manifest[field] !== undefined);
  if (declared.length === 0) {
    return;
  }
  const minimum = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\./);
  assert.ok(minimum, 'gladys_version must declare a minimum version');
  const [, major, minor] = minimum.map(Number);
  assert.ok(
    major > 5 || (major === 5 && minor >= 1),
    `${declared.join(', ')} require gladys_version >= 5.1.0, got "${manifest.gladys_version}"`,
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

test('the house coordinates are declared, since the code asks for them', () => {
  // `GET /api/integration/v1/house` answers 403 to an integration that did not
  // declare it: src/house.js and this field are one feature, and the install
  // screen shows it to the user as an authorization contract.
  assert.equal(manifest.location, true);
});

test('the search centre select offers exactly what normalizeConfig accepts', () => {
  const values = field('search_center').options.map((o) => o.value);
  assert.deepEqual(values, ['house', 'postal_code']);
  for (const value of values) {
    assert.equal(normalizeConfig({ search_center: value }).search_center, value);
  }
  // Anything else falls back on the default rather than being kept as is.
  assert.equal(
    normalizeConfig({ search_center: 'moon' }).search_center,
    DEFAULT_CONFIG.search_center,
  );
});

test('the house is named by a free-text field, since a select cannot list them', () => {
  // The core resolves `source` select options against an integration's DEVICES
  // only (`SELECT_SOURCES = ['devices']`), so the houses Gladys holds cannot be
  // offered as options: the field is a plain string the user types, and it must
  // stay optional — a single-house install never fills it in.
  const houseField = field('house_name');
  assert.equal(houseField.type, 'string');
  assert.equal(houseField.required, false);
  assert.equal(houseField.options, undefined, 'no static list of somebody else’s houses');
  assert.equal(houseField.source, undefined, 'the core has no "houses" source');
  assert.equal(houseField.default, undefined);
  assert.equal(DEFAULT_CONFIG.house_name, '', 'empty means the first located house');
});

// --- Scene triggers (GladysAssistant/Gladys#3110, preview) --------------------
// The scene editor renders these from the manifest alone, while the code fires
// them by key with a payload the core whitelists against them: a key declared
// on one side only is a trigger that never appears, or an event silently
// dropped. Hence the same both-ways check as the actions above.

test('the manifest declares exactly the scene triggers the code fires', () => {
  assert.deepEqual(
    (manifest.scene_triggers ?? []).map((t) => t.key).sort(),
    Object.keys(SCENE_TRIGGER_CONTRACT).sort(),
  );
});

test('each scene trigger declares exactly the filters and variables the code sends', () => {
  for (const trigger of manifest.scene_triggers) {
    const contract = SCENE_TRIGGER_CONTRACT[trigger.key];
    assert.deepEqual(
      (trigger.fields ?? []).map((f) => f.key),
      contract.filters,
      `filters of "${trigger.key}"`,
    );
    assert.deepEqual(
      (trigger.variables ?? []).map((v) => v.key),
      contract.variables,
      `variables of "${trigger.key}"`,
    );
  }
});

test('the scene triggers stay within the limits the core validates', () => {
  // Bounds of the spec: 1-20 triggers, <= 10 filters, <= 20 variables, keys of
  // at most 40 characters matching [a-z0-9_]. A manifest over any of them is
  // rejected whole, which takes the whole integration down with it.
  assert.ok(manifest.scene_triggers.length >= 1 && manifest.scene_triggers.length <= 20);
  for (const trigger of manifest.scene_triggers) {
    assert.match(trigger.key, /^[a-z0-9_]{1,40}$/, `trigger key "${trigger.key}"`);
    assert.ok(trigger.label?.en && trigger.label?.fr, `"${trigger.key}" needs both labels`);
    assert.ok((trigger.fields ?? []).length <= 10, `"${trigger.key}" has too many filters`);
    assert.ok((trigger.variables ?? []).length <= 20, `"${trigger.key}" has too many variables`);
    for (const field of trigger.fields ?? []) {
      assert.match(field.key, /^[a-z0-9_]+$/);
      assert.ok(field.label?.en && field.label?.fr, `filter "${field.key}" needs both labels`);
      // A trigger filter has no boolean (a toggle could never mean "any"), and
      // no secret: a scene's JSON is readable by every Gladys user.
      assert.ok(
        ['string', 'number', 'select', 'multi_select', 'section'].includes(field.type),
        `filter "${field.key}" has a type no scene trigger accepts`,
      );
      for (const option of field.options ?? []) {
        assert.ok(option.label?.en && option.label?.fr, `option "${option.value}"`);
      }
    }
    for (const variable of trigger.variables ?? []) {
      assert.match(variable.key, /^[a-z0-9_]+$/);
      assert.ok(['string', 'number', 'boolean'].includes(variable.type), 'scalars only');
      assert.ok(variable.label?.en && variable.label?.fr, `variable "${variable.key}"`);
    }
  }
});

test('the fuel filters offer exactly the fuels of the catalog', () => {
  const fuelFilters = manifest.scene_triggers.flatMap((t) =>
    (t.fields ?? []).filter((f) => f.key === 'fuel'),
  );
  assert.ok(fuelFilters.length > 0);
  for (const filter of fuelFilters) {
    assert.deepEqual(
      filter.options.map((o) => o.value),
      FUEL_KEYS,
    );
  }
});

test('the enum filters offer exactly the values the code sends', () => {
  const optionsOf = (triggerKey, fieldKey) =>
    manifest.scene_triggers
      .find((t) => t.key === triggerKey)
      .fields.find((f) => f.key === fieldKey)
      .options.map((o) => o.value)
      .sort();

  assert.deepEqual(optionsOf('price_updated', 'direction'), Object.values(PRICE_DIRECTIONS).sort());
  assert.deepEqual(optionsOf('feed_status_changed', 'status'), Object.values(FEED_STATUSES).sort());
});

test('the station filter is picked from the devices, and is never required', () => {
  const device = manifest.scene_triggers
    .find((t) => t.key === 'price_updated')
    .fields.find((f) => f.key === 'device');
  // `source: "devices"` makes Gladys list the stations the user added, by name;
  // `default` is refused with a source, and an empty filter is the wildcard the
  // description promises ("every station you follow").
  assert.equal(device.source, 'devices');
  assert.equal(device.options, undefined, 'a source and static options are exclusive');
  assert.equal(device.default, undefined);
  assert.notEqual(device.required, true);
});

// --- Scene actions (GladysAssistant/Gladys#3110, preview) --------------------

test('the manifest declares exactly the scene actions the code handles', () => {
  assert.deepEqual(
    (manifest.scene_actions ?? []).map((a) => a.key).sort(),
    Object.keys(SCENE_ACTIONS).sort(),
  );
  assert.deepEqual(Object.keys(SCENE_ACTIONS).sort(), Object.keys(SCENE_ACTION_CONTRACT).sort());
});

test('each scene action declares exactly the fields and outputs the code uses', () => {
  for (const action of manifest.scene_actions) {
    const contract = SCENE_ACTION_CONTRACT[action.key];
    assert.deepEqual(
      (action.fields ?? []).map((f) => f.key),
      contract.fields,
      `fields of "${action.key}"`,
    );
    assert.deepEqual(
      (action.outputs ?? []).map((o) => o.key),
      contract.outputs,
      `outputs of "${action.key}"`,
    );
  }
});

test('the scene actions stay within the limits the core validates', () => {
  assert.ok(manifest.scene_actions.length >= 1 && manifest.scene_actions.length <= 20);
  for (const action of manifest.scene_actions) {
    assert.match(action.key, /^[a-z0-9_]{1,40}$/, `action key "${action.key}"`);
    assert.ok(action.label?.en && action.label?.fr, `"${action.key}" needs both labels`);
    // The ack delay a scene grants the container: 5-120s, and ours read a
    // national open data API before answering.
    assert.ok(
      Number.isInteger(action.timeout_seconds) &&
        action.timeout_seconds >= 5 &&
        action.timeout_seconds <= 120,
      `"${action.key}" declares an impossible timeout`,
    );
    assert.ok((action.fields ?? []).length <= 10, `"${action.key}" has too many fields`);
    assert.ok((action.outputs ?? []).length <= 20, `"${action.key}" has too many outputs`);
    for (const field of action.fields ?? []) {
      assert.match(field.key, /^[a-z0-9_]+$/);
      assert.ok(field.label?.en && field.label?.fr, `field "${field.key}" needs both labels`);
      // An action parameter accepts `boolean` (a trigger filter does not), but
      // never a secret: a scene's JSON is readable by every Gladys user.
      assert.ok(
        ['string', 'number', 'boolean', 'select', 'multi_select', 'section'].includes(field.type),
        `field "${field.key}" has a type no scene action accepts`,
      );
      // A required field WITHOUT a default breaks every existing scene the day
      // it is added, and the core then fails the action at execution.
      if (field.required === true) {
        assert.notEqual(field.default, undefined, `required field "${field.key}" needs a default`);
      }
      for (const option of field.options ?? []) {
        assert.ok(option.label?.en && option.label?.fr, `option "${option.value}"`);
      }
    }
    for (const output of action.outputs ?? []) {
      assert.match(output.key, /^[a-z0-9_]+$/);
      assert.ok(['string', 'number', 'boolean'].includes(output.type), 'scalars only');
      assert.ok(output.label?.en && output.label?.fr, `output "${output.key}"`);
    }
  }
});

test('the fuel fields of the scene actions offer exactly the fuels of the catalog', () => {
  const fuelFields = manifest.scene_actions.flatMap((a) =>
    (a.fields ?? []).filter((f) => f.key === 'fuel'),
  );
  assert.equal(fuelFields.length, 2, 'both the cheapest-station and the report ask for a fuel');
  for (const field of fuelFields) {
    assert.deepEqual(
      field.options.map((o) => o.value),
      FUEL_KEYS,
    );
    assert.ok(FUEL_KEYS.includes(field.default), 'the default fuel must exist');
  }
});

test('the bounds of the report match the ones the handler clamps to', () => {
  const field = manifest.scene_actions
    .find((a) => a.key === 'price_report')
    .fields.find((f) => f.key === 'max_stations');
  // Same reason as the config_schema bounds: the form prevents the mistake,
  // the handler protects itself from a value that arrived another way.
  assert.equal(field.min, REPORT_LIMITS.MIN);
  assert.equal(field.max, REPORT_LIMITS.MAX);
  assert.equal(field.default, REPORT_LIMITS.DEFAULT);
});

test('the scene actions and the button actions are two namespaces', () => {
  // The spec allows the same key in both lists, and the two answer differently
  // (a message under a button vs outputs fed to a scene): the handlers must
  // never be mixed up.
  for (const key of Object.keys(SCENE_ACTIONS)) {
    if (ACTIONS[key]) {
      assert.notEqual(SCENE_ACTIONS[key], ACTIONS[key], `"${key}" must not share a handler`);
    }
  }
});

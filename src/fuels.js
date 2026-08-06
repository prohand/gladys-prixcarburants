// -----------------------------------------------------------------------------
// Fuel catalog.
//
// The list of fuel types the integration knows about, in a single place so the
// manifest `config_schema`, the country providers and the device names always
// agree on the same keys.
//
// A key is part of the device external_id (`FR-35000005-gazole`): it MUST stay
// stable across versions, otherwise the devices a user already added would be
// orphaned. Add new keys, never rename existing ones.
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} Fuel
 * @property {string} key    stable identifier, used in external ids
 * @property {{ en: string, fr: string }} label human readable name
 */

/** @type {Record<string, Fuel>} */
export const FUELS = {
  gazole: { key: 'gazole', label: { en: 'Diesel', fr: 'Gazole' } },
  sp95: { key: 'sp95', label: { en: 'SP95', fr: 'SP95' } },
  sp98: { key: 'sp98', label: { en: 'SP98', fr: 'SP98' } },
  e10: { key: 'e10', label: { en: 'E10 (SP95-E10)', fr: 'E10 (SP95-E10)' } },
  e85: { key: 'e85', label: { en: 'E85 (Superethanol)', fr: 'E85 (Superéthanol)' } },
  gplc: { key: 'gplc', label: { en: 'LPG', fr: 'GPLc' } },
};

export const FUEL_KEYS = Object.keys(FUELS);

/**
 * Human readable label of a fuel, with a safe fallback for an unknown key
 * (a device added with a key removed from a later version keeps a usable name).
 * @param {string} key
 * @param {'en'|'fr'} [lang]
 */
export function fuelLabel(key, lang = 'en') {
  return FUELS[key]?.label[lang] ?? key.toUpperCase();
}

/**
 * Keep only the fuel keys this integration supports, preserving the catalog
 * order so the device list is deterministic whatever the user clicked first.
 * @param {unknown} keys value coming from the configuration form
 * @returns {string[]}
 */
export function normalizeFuelKeys(keys) {
  const requested = Array.isArray(keys) ? keys : [keys];
  const wanted = new Set(
    requested.filter((k) => typeof k === 'string').map((k) => k.toLowerCase()),
  );
  return FUEL_KEYS.filter((key) => wanted.has(key));
}

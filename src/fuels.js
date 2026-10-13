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
 * @property {{ en: string, fr: string, de: string, es: string }} label human readable name
 */

/** @type {Record<string, Fuel>} */
export const FUELS = {
  gazole: { key: 'gazole', label: { en: 'Diesel', fr: 'Gazole', de: 'Diesel', es: 'Gasóleo' } },
  sp95: { key: 'sp95', label: { en: 'SP95', fr: 'SP95', de: 'SP95', es: 'SP95' } },
  sp98: { key: 'sp98', label: { en: 'SP98', fr: 'SP98', de: 'SP98', es: 'SP98' } },
  e10: {
    key: 'e10',
    label: {
      en: 'E10 (SP95-E10)',
      fr: 'E10 (SP95-E10)',
      de: 'E10 (SP95-E10)',
      es: 'E10 (SP95-E10)',
    },
  },
  e85: {
    key: 'e85',
    label: {
      en: 'E85 (Superethanol)',
      fr: 'E85 (Superéthanol)',
      de: 'E85 (Superethanol)',
      es: 'E85 (Superetanol)',
    },
  },
  gplc: { key: 'gplc', label: { en: 'LPG', fr: 'GPLc', de: 'Autogas (LPG)', es: 'GLP' } },
};

export const FUEL_KEYS = Object.keys(FUELS);

/**
 * Human readable label of a fuel, with a safe fallback for an unknown key
 * (a device added with a key removed from a later version keeps a usable name).
 * @param {string} key
 * @param {string} [lang] ISO 639-1; `en` for a language the catalog does not speak
 */
export function fuelLabel(key, lang = 'en') {
  const label = FUELS[key]?.label;
  return label ? (label[lang] ?? label.en) : key.toUpperCase();
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

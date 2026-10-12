// -----------------------------------------------------------------------------
// Integration configuration.
//
// The configuration is filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches it for you
// (`gladys.getConfig()`) and notifies you of every change through
// `gladys.onConfigUpdated()`.
//
// This module only provides defaults and normalizes the received object, so the
// rest of the code never has to deal with `undefined` or with a number that
// arrived as a string from the form.
// -----------------------------------------------------------------------------

import { DEFAULT_COUNTRY, isSupportedCountry } from './countries/index.js';
import { normalizeFuelKeys } from './fuels.js';

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (checked by test/manifest.test.js).
export const DEFAULT_CONFIG = {
  country: DEFAULT_COUNTRY, // 'FR' — other countries can be added later
  postal_code: '', // required, no sensible default
  fuel_type: ['gazole'], // one device per station AND per selected fuel
  search_center: 'house', // 'house' (falls back to the postal code) | 'postal_code'
  house: '', // the selector of the Gladys house picked in the list; empty = the first
  house_name: '', // the name typed up to 2.3, off the schema now; read when `house` is empty
  search_radius_km: 10, // 0 = the postal code only
  max_stations: 20, // safety net: how many stations discovery may publish
  poll_frequency: 3600, // seconds between two price refreshes
};

/**
 * Clamp a number coming from the configuration form.
 * @param {unknown} value
 * @param {number} fallback used when the value is missing or not a number
 * @param {number} min
 * @param {number} max
 */
function toNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Merge the user config with the defaults and force the types.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const country = String(raw.country ?? DEFAULT_CONFIG.country).toUpperCase();
  const fuelTypes = normalizeFuelKeys(raw.fuel_type ?? DEFAULT_CONFIG.fuel_type);

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    country: isSupportedCountry(country) ? country : DEFAULT_CONFIG.country,
    // Postal codes are never arithmetic: keep them as trimmed strings so a
    // leading zero (01000) survives the round trip.
    postal_code: String(raw.postal_code ?? '').trim(),
    // An empty selection would silently create no device at all: fall back to
    // the default so the user always gets something to add.
    fuel_type: fuelTypes.length > 0 ? fuelTypes : [...DEFAULT_CONFIG.fuel_type],
    // Anything but the explicit 'postal_code' means "use the house when Gladys
    // knows where it is": the fallback is automatic, so an unlocated house is
    // never an error, just a distance measured from the postal code.
    search_center:
      raw.search_center === 'postal_code' ? 'postal_code' : DEFAULT_CONFIG.search_center,
    // The house picked in a `source: "houses"` select (Gladys 5.2): the core
    // stores its SELECTOR, never its name nor its coordinates.
    house: String(raw.house ?? '').trim(),
    // The free-text name of up to 2.3 — off the schema since the select exists,
    // but the core still hands back the value a user typed, and an install
    // that never opens the form again must keep measuring from the same house.
    house_name: String(raw.house_name ?? '').trim(),
    search_radius_km: toNumber(raw.search_radius_km, DEFAULT_CONFIG.search_radius_km, 0, 50),
    max_stations: toNumber(raw.max_stations, DEFAULT_CONFIG.max_stations, 1, 50),
    poll_frequency: toNumber(raw.poll_frequency, DEFAULT_CONFIG.poll_frequency, 600, 86400),
  };
}

/**
 * The house the configuration asks for: the one picked in the list, or else the
 * name typed before the list existed. `src/house.js` matches the answer against
 * the selector first, then loosely against the name. Empty = the first house.
 * @param {{ house?: string, house_name?: string }} config
 */
export function preferredHouse(config) {
  return config.house || config.house_name || '';
}

/**
 * Is the configuration complete enough to search for stations?
 * Used to skip the network call (and log something actionable) instead of
 * querying the provider with an empty postal code.
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function isConfigReady(config) {
  return config.postal_code.length > 0;
}

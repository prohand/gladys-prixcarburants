// -----------------------------------------------------------------------------
// Country registry.
//
// Fuel price open data is national: every country publishes its own dataset,
// with its own fields and its own idea of what a postal code looks like. So the
// integration keeps ONE provider per country behind a common interface, and the
// rest of the code (devices, polling, discovery) never knows which country it
// is talking to.
//
// ---------------------------------------------------------------------------
// Adding a country
// ---------------------------------------------------------------------------
//  1. create `src/countries/<country>.js` exporting an object with:
//       code               : ISO 3166-1 alpha-2 code, e.g. 'BE'
//       label              : { en, fr } shown in the country select
//       postalCodeExample  : a valid postal code, used in the documentation
//       fuels              : the fuel keys (src/fuels.js) this country serves
//       attribution        : { en, fr } credit line required by the licence
//       isValidPostalCode(postalCode) -> boolean
//       searchStations({ postalCode, radiusKm, limit }) -> Promise<Station[]>
//       fetchStationsByIds(ids) -> Promise<Station[]>
//  2. register it in COUNTRIES below;
//  3. add its option to the `country` field of the manifest `config_schema`.
//
// Nothing else changes: device ids already carry the country code
// (`FR-35000005-gazole`), so stations from two countries can coexist.
// -----------------------------------------------------------------------------

import { france } from './france.js';

/** @type {Record<string, typeof france>} */
export const COUNTRIES = {
  [france.code]: france,
};

export const DEFAULT_COUNTRY = france.code;

/**
 * @param {string} code ISO 3166-1 alpha-2 country code
 */
export function isSupportedCountry(code) {
  return Object.hasOwn(COUNTRIES, String(code ?? '').toUpperCase());
}

/**
 * Provider of a country, falling back to the default one so a configuration
 * pointing at a country removed from a later version keeps working.
 * @param {string} code
 */
export function getProvider(code) {
  return COUNTRIES[String(code ?? '').toUpperCase()] ?? COUNTRIES[DEFAULT_COUNTRY];
}

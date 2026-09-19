// -----------------------------------------------------------------------------
// Manifest actions: the buttons of the Configuration screen.
//
// Each handler resolves a multi-language message displayed under its button (a
// thrown error is displayed too), which makes them the natural place for the
// two things a user wants before trusting the integration: "does my postal code
// return anything?" and "refresh my prices now".
// -----------------------------------------------------------------------------

import { getProvider } from './countries/index.js';
import { fuelLabel } from './fuels.js';
import { isConfigReady } from './config.js';
import { refreshAllDevices } from './refresh.js';

// How many stations the search result message lists before summarizing.
const PREVIEW_SIZE = 8;

/**
 * Preview the stations the current configuration would offer in the discovery
 * tab, without touching the device list.
 * @param {object} gladys SDK instance
 * @param {{ config: object, store: object }} context
 */
export async function searchStations(gladys, { config, store }) {
  if (!isConfigReady(config)) {
    return {
      en: 'Fill in a postal code first.',
      fr: "Renseignez d'abord un code postal.",
    };
  }

  const provider = getProvider(config.country);
  if (!provider.isValidPostalCode(config.postal_code)) {
    return {
      en: `"${config.postal_code}" is not a valid ${provider.label.en} postal code (example: ${provider.postalCodeExample}).`,
      fr: `« ${config.postal_code} » n'est pas un code postal ${provider.label.fr} valide (exemple : ${provider.postalCodeExample}).`,
    };
  }

  const stations = await store.search(config);
  if (stations.length === 0) {
    return {
      en: `No station found around ${config.postal_code}. Try a wider search radius.`,
      fr: `Aucune station trouvée autour de ${config.postal_code}. Essayez un rayon de recherche plus large.`,
    };
  }

  const lines = stations.slice(0, PREVIEW_SIZE).map((station) => {
    const distance = Number.isFinite(station.distanceKm)
      ? ` (${station.distanceKm.toFixed(1)} km)`
      : '';
    const prices = config.fuel_type
      .map((fuel) => {
        const price = station.prices[fuel];
        return `${fuelLabel(fuel)}: ${price === null || price === undefined ? '-' : `${price.toFixed(3)} EUR/L`}`;
      })
      .join(', ');
    return `• ${station.name}${distance} — ${prices}`;
  });
  const more = stations.length > lines.length ? `\n… +${stations.length - lines.length}` : '';

  return {
    en: `${stations.length} station(s) around ${config.postal_code}:\n${lines.join('\n')}${more}\n\nAdd the ones you want from the Discovery tab.`,
    fr: `${stations.length} station(s) autour de ${config.postal_code} :\n${lines.join('\n')}${more}\n\nAjoutez celles que vous voulez depuis l'onglet Découverte.`,
  };
}

/**
 * Force an immediate price refresh of every station device already added,
 * without waiting for the next poll.
 * @param {object} gladys SDK instance
 * @param {{ config: object, store: object }} context
 */
export async function refreshPrices(gladys, { config, store, history }) {
  // `force`: the user pressed a button, they expect a real read, not the cache.
  const { total, updated, failures } = await refreshAllDevices(gladys, {
    config,
    store,
    history,
    force: true,
  });

  if (total === 0) {
    return {
      en: 'No station added yet: add one from the Discovery tab first.',
      fr: "Aucune station ajoutée : ajoutez-en une depuis l'onglet Découverte.",
    };
  }

  const failureSuffix = failures.length > 0 ? ` (${failures.length} failed)` : '';
  return {
    en: `${updated}/${total} price(s) refreshed${failureSuffix}.`,
    fr: `${updated}/${total} prix rafraîchi(s)${failureSuffix}.`,
  };
}

/** Action key -> handler, consumed by index.js and checked by the tests. */
export const ACTIONS = {
  search_stations: searchStations,
  refresh_prices: refreshPrices,
};

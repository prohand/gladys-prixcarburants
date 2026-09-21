// -----------------------------------------------------------------------------
// Manifest actions: the buttons of the Configuration screen.
//
// Each handler resolves a multi-language message displayed under its button (a
// thrown error is displayed too), which makes them the natural place for the
// two things a user wants before trusting the integration: "does my postal code
// return anything?" and "refresh my prices now".
// -----------------------------------------------------------------------------

import { AVAILABILITY, fuelAvailability } from './availability.js';
import { getProvider } from './countries/index.js';
import { fuelLabel } from './fuels.js';
import { isConfigReady } from './config.js';
import { refreshAllDevices } from './refresh.js';

// How many stations the search result message lists before summarizing.
const PREVIEW_SIZE = 8;

// What the preview writes instead of a price when the station publishes none.
// A pump the station does not have is NOT a missing reading: no device is ever
// offered for that (station, fuel) pair. Saying it in words is what tells a
// user that their TotalEnergies really has no SP95 — it sells E10 (SP95-E10)
// instead — rather than the integration having lost a price.
//
// An empty price column covers TWO situations though, and calling both of them
// "non vendu" is what users report as a bug: a station out of stock does sell
// that fuel. The feed says which is which (see src/availability.js), so the
// preview says it too.
const NO_PRICE = {
  [AVAILABILITY.NOT_SOLD]: { en: 'not sold', fr: 'non vendu' },
  [AVAILABILITY.OUT_OF_STOCK]: { en: 'out of stock', fr: 'en rupture' },
};

// Ticking a fuel nobody around sells looks exactly like a bug seen from the
// Discovery tab: the stations are listed, one of the fuels is simply never
// offered. The hint names the usual culprit instead of leaving the user to
// guess. Keyed by fuel, so only a fuel that HAS a replacement carries one.
const FUEL_HINTS = {
  sp95: {
    en: 'SP95 is being replaced by E10 (SP95-E10) in many stations: tick E10 to follow it.',
    fr: 'Le SP95 est remplacé par le E10 (SP95-E10) dans beaucoup de stations : cochez E10 pour le suivre.',
  },
};

/**
 * A price as the preview shows it, or why there is none.
 * @param {object} station
 * @param {string} fuel
 * @param {'en'|'fr'} lang
 */
function formatPrice(station, fuel, lang) {
  const availability = fuelAvailability(station, fuel);
  if (availability === AVAILABILITY.AVAILABLE) {
    return `${station.prices[fuel].toFixed(3)} EUR/L`;
  }
  return NO_PRICE[availability][lang];
}

/**
 * The first `PREVIEW_SIZE` stations, one line each, in one language.
 * @param {Array<object>} stations
 * @param {string[]} fuels
 * @param {'en'|'fr'} lang
 */
function previewLines(stations, fuels, lang) {
  return stations.slice(0, PREVIEW_SIZE).map((station) => {
    const distance = Number.isFinite(station.distanceKm)
      ? ` (${station.distanceKm.toFixed(1)} km)`
      : '';
    // French puts a space before a colon; the rest of the message already does.
    const colon = lang === 'fr' ? ' : ' : ': ';
    const prices = fuels
      .map((fuel) => `${fuelLabel(fuel, lang)}${colon}${formatPrice(station, fuel, lang)}`)
      .join(', ');
    return `• ${station.name}${distance} — ${prices}`;
  });
}

/**
 * One sentence per selected fuel that NO station around sells, so the user
 * knows why the Discovery tab offers nothing for it.
 *
 * A fuel every station is merely OUT OF STOCK of gets its own sentence: the
 * devices ARE offered in that case, they are just waiting for a price, and
 * telling the user "nobody sells it" would send them changing a configuration
 * that is perfectly right.
 *
 * @param {Array<object>} stations
 * @param {string[]} fuels
 * @param {'en'|'fr'} lang
 */
function missingFuelNotes(stations, fuels, lang) {
  return fuels
    .filter((fuel) =>
      stations.every((station) => fuelAvailability(station, fuel) !== AVAILABILITY.AVAILABLE),
    )
    .map((fuel) => {
      const soldSomewhere = stations.some(
        (station) => fuelAvailability(station, fuel) === AVAILABILITY.OUT_OF_STOCK,
      );
      if (soldSomewhere) {
        return lang === 'fr'
          ? `Le ${fuelLabel(fuel, 'fr')} est en rupture dans toutes ces stations : les appareils sont proposés, le prix reviendra avec le carburant.`
          : `${fuelLabel(fuel, 'en')} is out of stock in every one of these stations: the devices are offered, the price will come back with the fuel.`;
      }
      const head =
        lang === 'fr'
          ? `Aucune de ces stations ne vend du ${fuelLabel(fuel, 'fr')}.`
          : `None of these stations sells ${fuelLabel(fuel, 'en')}.`;
      const hint = FUEL_HINTS[fuel]?.[lang];
      return hint ? `${head} ${hint}` : head;
    });
}

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

  const shown = Math.min(stations.length, PREVIEW_SIZE);
  const more = stations.length > shown ? `\n… +${stations.length - shown}` : '';
  const notes = (lang) => {
    const lines = missingFuelNotes(stations, config.fuel_type, lang);
    return lines.length > 0 ? `\n\n${lines.join('\n')}` : '';
  };

  return {
    en: `${stations.length} station(s) around ${config.postal_code}:\n${previewLines(stations, config.fuel_type, 'en').join('\n')}${more}${notes('en')}\n\nAdd the ones you want from the Discovery tab.`,
    fr: `${stations.length} station(s) autour de ${config.postal_code} :\n${previewLines(stations, config.fuel_type, 'fr').join('\n')}${more}${notes('fr')}\n\nAjoutez celles que vous voulez depuis l'onglet Découverte.`,
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

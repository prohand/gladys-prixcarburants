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
import { inEveryLanguage } from './i18n.js';
import { isConfigReady, preferredHouse } from './config.js';
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
  [AVAILABILITY.NOT_SOLD]: {
    en: 'not sold',
    fr: 'non vendu',
    de: 'nicht verkauft',
    es: 'no se vende',
  },
  [AVAILABILITY.OUT_OF_STOCK]: {
    en: 'out of stock',
    fr: 'en rupture',
    de: 'ausverkauft',
    es: 'agotado',
  },
};

// Ticking a fuel nobody around sells looks exactly like a bug seen from the
// Discovery tab: the stations are listed, one of the fuels is simply never
// offered. The hint names the usual culprit instead of leaving the user to
// guess. Keyed by fuel, so only a fuel that HAS a replacement carries one.
const FUEL_HINTS = {
  sp95: {
    en: 'SP95 is being replaced by E10 (SP95-E10) in many stations: tick E10 to follow it.',
    fr: 'Le SP95 est remplacé par le E10 (SP95-E10) dans beaucoup de stations : cochez E10 pour le suivre.',
    de: 'SP95 wird an vielen Tankstellen durch E10 (SP95-E10) ersetzt: Wählen Sie E10, um es zu verfolgen.',
    es: 'En muchas gasolineras el SP95 se está sustituyendo por el E10 (SP95-E10): marque E10 para seguirlo.',
  },
};

// The sentences of the preview that depend on the language, one entry per
// language of `LANGUAGES`. `colon` is the label/value separator of a price:
// French puts a space before a colon, the other languages do not.
const PREVIEW_TEXT = {
  en: {
    colon: ': ',
    outOfStockEverywhere: (fuel) =>
      `${fuel} is out of stock in every one of these stations: the devices are offered, the price will come back with the fuel.`,
    soldNowhere: (fuel) => `None of these stations sells ${fuel}.`,
    fromPostalCode: (code) => `Distances measured from the centre of ${code}.`,
    noLocatedHouse: (code) =>
      `No Gladys house has coordinates: distances measured from the centre of ${code}.`,
    knownHouses: (names) => ` Houses Gladys knows: ${names}.`,
    houseArea: (name) => `the house "${name}"`,
    fromHouse: (name) => `Distances measured from the house "${name}".`,
    noPostalCode: 'Fill in a postal code first.',
    invalidPostalCode: (code, country, example) =>
      `"${code}" is not a valid ${country} postal code (example: ${example}).`,
    noStation: (area) => `No station found around ${area}. Try a wider search radius.`,
    found: (count, area) => `${count} station(s) around ${area}:`,
    addFromDiscovery: 'Add the ones you want from the Discovery tab.',
    noTrackedStation: 'No station added yet: add one from the Discovery tab first.',
    failed: (count) => ` (${count} failed)`,
    refreshed: (updated, total, suffix) => `${updated}/${total} price(s) refreshed${suffix}.`,
  },
  fr: {
    colon: ' : ',
    outOfStockEverywhere: (fuel) =>
      `Le ${fuel} est en rupture dans toutes ces stations : les appareils sont proposés, le prix reviendra avec le carburant.`,
    soldNowhere: (fuel) => `Aucune de ces stations ne vend du ${fuel}.`,
    fromPostalCode: (code) => `Distances mesurées depuis le centre du ${code}.`,
    noLocatedHouse: (code) =>
      `Aucune maison Gladys n'a de coordonnées : distances mesurées depuis le centre du ${code}.`,
    knownHouses: (names) => ` Maisons connues de Gladys : ${names}.`,
    houseArea: (name) => `la maison « ${name} »`,
    fromHouse: (name) => `Distances mesurées depuis la maison « ${name} ».`,
    noPostalCode: "Renseignez d'abord un code postal.",
    invalidPostalCode: (code, country, example) =>
      `« ${code} » n'est pas un code postal ${country} valide (exemple : ${example}).`,
    noStation: (area) =>
      `Aucune station trouvée autour de ${area}. Essayez un rayon de recherche plus large.`,
    found: (count, area) => `${count} station(s) autour de ${area} :`,
    addFromDiscovery: "Ajoutez celles que vous voulez depuis l'onglet Découverte.",
    noTrackedStation: "Aucune station ajoutée : ajoutez-en une depuis l'onglet Découverte.",
    failed: (count) => ` (${count} en échec)`,
    refreshed: (updated, total, suffix) => `${updated}/${total} prix rafraîchi(s)${suffix}.`,
  },
  de: {
    colon: ': ',
    outOfStockEverywhere: (fuel) =>
      `${fuel} ist an all diesen Tankstellen ausverkauft: Die Geräte werden angeboten, der Preis kommt mit dem Kraftstoff zurück.`,
    soldNowhere: (fuel) => `Keine dieser Tankstellen verkauft ${fuel}.`,
    fromPostalCode: (code) => `Entfernungen gemessen ab der Mitte von ${code}.`,
    noLocatedHouse: (code) =>
      `Kein Gladys-Zuhause hat Koordinaten: Entfernungen gemessen ab der Mitte von ${code}.`,
    knownHouses: (names) => ` Zuhause, die Gladys kennt: ${names}.`,
    houseArea: (name) => `das Zuhause „${name}“`,
    fromHouse: (name) => `Entfernungen gemessen ab dem Zuhause „${name}“.`,
    noPostalCode: 'Geben Sie zuerst eine Postleitzahl ein.',
    invalidPostalCode: (code, country, example) =>
      `„${code}“ ist keine gültige Postleitzahl für ${country} (Beispiel: ${example}).`,
    noStation: (area) =>
      `Keine Tankstelle um ${area} gefunden. Versuchen Sie einen größeren Suchradius.`,
    found: (count, area) => `${count} Tankstelle(n) um ${area}:`,
    addFromDiscovery: 'Fügen Sie die gewünschten über den Tab „Entdecken“ hinzu.',
    noTrackedStation:
      'Noch keine Tankstelle hinzugefügt: Fügen Sie zuerst eine über den Tab „Entdecken“ hinzu.',
    failed: (count) => ` (${count} fehlgeschlagen)`,
    refreshed: (updated, total, suffix) => `${updated}/${total} Preis(e) aktualisiert${suffix}.`,
  },
  es: {
    colon: ': ',
    outOfStockEverywhere: (fuel) =>
      `${fuel}: agotado en todas estas gasolineras. Los dispositivos se ofrecen y el precio volverá con el carburante.`,
    soldNowhere: (fuel) => `Ninguna de estas gasolineras vende ${fuel}.`,
    fromPostalCode: (code) => `Distancias medidas desde el centro de ${code}.`,
    noLocatedHouse: (code) =>
      `Ninguna vivienda de Gladys tiene coordenadas: distancias medidas desde el centro de ${code}.`,
    knownHouses: (names) => ` Viviendas que conoce Gladys: ${names}.`,
    houseArea: (name) => `la vivienda «${name}»`,
    fromHouse: (name) => `Distancias medidas desde la vivienda «${name}».`,
    noPostalCode: 'Introduzca primero un código postal.',
    invalidPostalCode: (code, country, example) =>
      `«${code}» no es un código postal válido de ${country} (ejemplo: ${example}).`,
    noStation: (area) =>
      `No se ha encontrado ninguna gasolinera alrededor de ${area}. Pruebe con un radio de búsqueda mayor.`,
    found: (count, area) => `${count} gasolinera(s) alrededor de ${area}:`,
    addFromDiscovery: 'Añada las que quiera desde la pestaña «Descubrir».',
    noTrackedStation:
      'Todavía no ha añadido ninguna gasolinera: añada una primero desde la pestaña «Descubrir».',
    failed: (count) => ` (${count} con error)`,
    refreshed: (updated, total, suffix) => `${updated}/${total} precio(s) actualizado(s)${suffix}.`,
  },
};

/**
 * A price as the preview shows it, or why there is none.
 * @param {object} station
 * @param {string} fuel
 * @param {string} lang one of `LANGUAGES`
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
 * @param {string} lang one of `LANGUAGES`
 */
function previewLines(stations, fuels, lang) {
  return stations.slice(0, PREVIEW_SIZE).map((station) => {
    const distance = Number.isFinite(station.distanceKm)
      ? ` (${station.distanceKm.toFixed(1)} km)`
      : '';
    const prices = fuels
      .map(
        (fuel) =>
          `${fuelLabel(fuel, lang)}${PREVIEW_TEXT[lang].colon}${formatPrice(station, fuel, lang)}`,
      )
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
 * @param {string} lang one of `LANGUAGES`
 */
function missingFuelNotes(stations, fuels, lang) {
  const words = PREVIEW_TEXT[lang];
  return fuels
    .filter((fuel) =>
      stations.every((station) => fuelAvailability(station, fuel) !== AVAILABILITY.AVAILABLE),
    )
    .map((fuel) => {
      const soldSomewhere = stations.some(
        (station) => fuelAvailability(station, fuel) === AVAILABILITY.OUT_OF_STOCK,
      );
      if (soldSomewhere) {
        return words.outOfStockEverywhere(fuelLabel(fuel, lang));
      }
      const head = words.soldNowhere(fuelLabel(fuel, lang));
      const hint = FUEL_HINTS[fuel]?.[lang];
      return hint ? `${head} ${hint}` : head;
    });
}

/**
 * Where the distances of this preview start from — and, when Gladys holds more
 * than one house, the NAMES of the houses it holds.
 *
 * The "Which house" field is a list since Gladys 5.2, but it lists EVERY house,
 * located or not, and an empty choice means "the first located one": the button
 * a user presses to check their postal code is where they read back which house
 * that turned out to be.
 *
 * Best effort like everything house-related: no house module, no coordinates,
 * an older core — the line simply says the postal code.
 *
 * @param {object} config normalized configuration
 * @param {{ get: Function, names: Function }} [house]
 * @returns {Promise<{ area: Record<string, string>, note: Record<string, string> }>}
 *   one entry per language of `LANGUAGES` in each
 */
async function centerNotes(config, house) {
  // `area` heads the message ("12 station(s) around …"): it names the same
  // centre as the note, since a head saying the postal code over a search
  // centred on the house sent a user looking for a bug that was not there.
  const postalArea = inEveryLanguage(() => config.postal_code);
  if (config.search_center !== 'house' || !house) {
    return {
      area: postalArea,
      note: inEveryLanguage((lang) => PREVIEW_TEXT[lang].fromPostalCode(config.postal_code)),
    };
  }
  const [used, names] = await Promise.all([house.get(preferredHouse(config)), house.names()]);
  if (!used) {
    return {
      area: postalArea,
      note: inEveryLanguage((lang) => PREVIEW_TEXT[lang].noLocatedHouse(config.postal_code)),
    };
  }
  // Only worth listing when there is a choice to make. The names come from the
  // user's own Gladys and never leave this message — no coordinate is printed,
  // here or anywhere else.
  const others = (lang) =>
    names.length > 1 ? PREVIEW_TEXT[lang].knownHouses(names.join(', ')) : '';
  return {
    area: inEveryLanguage((lang) => PREVIEW_TEXT[lang].houseArea(used.name)),
    note: inEveryLanguage((lang) => `${PREVIEW_TEXT[lang].fromHouse(used.name)}${others(lang)}`),
  };
}

/**
 * Preview the stations the current configuration would offer in the discovery
 * tab, without touching the device list.
 * @param {object} gladys SDK instance
 * @param {{ config: object, store: object, house?: object }} context
 */
export async function searchStations(gladys, { config, store, house }) {
  if (!isConfigReady(config)) {
    return inEveryLanguage((lang) => PREVIEW_TEXT[lang].noPostalCode);
  }

  const provider = getProvider(config.country);
  if (!provider.isValidPostalCode(config.postal_code)) {
    return inEveryLanguage((lang) =>
      PREVIEW_TEXT[lang].invalidPostalCode(
        config.postal_code,
        provider.label[lang] ?? provider.label.en,
        provider.postalCodeExample,
      ),
    );
  }

  const [stations, center] = await Promise.all([store.search(config), centerNotes(config, house)]);
  if (stations.length === 0) {
    return inEveryLanguage((lang) => PREVIEW_TEXT[lang].noStation(center.area[lang]));
  }

  const shown = Math.min(stations.length, PREVIEW_SIZE);
  const more = stations.length > shown ? `\n… +${stations.length - shown}` : '';
  const notes = (lang) => {
    const lines = missingFuelNotes(stations, config.fuel_type, lang);
    return lines.length > 0 ? `\n\n${lines.join('\n')}` : '';
  };

  return inEveryLanguage((lang) => {
    const words = PREVIEW_TEXT[lang];
    const lines = previewLines(stations, config.fuel_type, lang).join('\n');
    return `${words.found(stations.length, center.area[lang])}\n${lines}${more}${notes(lang)}\n\n${center.note[lang]}\n\n${words.addFromDiscovery}`;
  });
}

/**
 * Force an immediate price refresh of every station device already added,
 * without waiting for the next poll.
 * @param {object} gladys SDK instance
 * @param {{ config: object, store: object, history?: object, sceneEvents?: object }} context
 */
export async function refreshPrices(gladys, { config, store, history, sceneEvents = null }) {
  // `force`: the user pressed a button, they expect a real read, not the cache.
  // A manual refresh is a refresh like any other: a price that moved since the
  // previous pass fires its scene trigger here too.
  const { total, updated, failures } = await refreshAllDevices(gladys, {
    config,
    store,
    history,
    force: true,
    sceneEvents,
  });

  if (total === 0) {
    return inEveryLanguage((lang) => PREVIEW_TEXT[lang].noTrackedStation);
  }

  return inEveryLanguage((lang) => {
    const words = PREVIEW_TEXT[lang];
    const suffix = failures.length > 0 ? words.failed(failures.length) : '';
    return words.refreshed(updated, total, suffix);
  });
}

/** Action key -> handler, consumed by index.js and checked by the tests. */
export const ACTIONS = {
  search_stations: searchStations,
  refresh_prices: refreshPrices,
};

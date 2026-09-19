// -----------------------------------------------------------------------------
// Widget: "Cheapest around me"
//
// The question this integration exists to answer, on the dashboard instead of
// in a device list: where do I fill up today, and how much will it cost?
//
// One card: the cheapest price as a tile, the average next to it (a price only
// means something compared to the others), then the ranking of the stations
// with their distance and the date they declared that price. Tapping a station
// opens the core's detail panel with its address and a navigation link.
//
// The ranking is built from the SAME station store as the devices, so opening a
// dashboard costs at most one open data request per TTL, shared with whatever
// the refresh loop was already doing.
// -----------------------------------------------------------------------------

import { isConfigReady } from '../config.js';
import { FUELS, FUEL_KEYS, fuelLabel } from '../fuels.js';
import { COLOR, buildContent, button, cardList, text, valueTile } from './content.js';
import {
  PRICE_UNIT,
  directionsUrl,
  formatDistance,
  formatPrice,
  stationAddress,
} from './format.js';

export const KEY = 'best_prices';

/** How long the core may serve this card from its cache (seconds). */
const TTL_SECONDS = 600;

/** Scopes offered in the settings: search around the postal code, or my stations. */
const SCOPE = { AROUND: 'around', TRACKED: 'tracked' };

/** Rankings the user can pick, as strings — a `select` value is a string. */
const COUNTS = ['3', '5', '8'];
const DEFAULT_COUNT = '5';

/**
 * Manifest declaration. Mirrored in `gladys-assistant-integration.json` and
 * checked both ways by test/manifest.test.js — this object is the source.
 */
export const DECLARATION = {
  key: KEY,
  label: { en: 'Cheapest around me', fr: 'Les moins chers' },
  description: {
    en: 'The cheapest stations for one fuel, with their distance.',
    fr: 'Les stations les moins chères pour un carburant, avec leur distance.',
  },
  icon: 'trending-down',
  settings: [
    {
      key: 'fuel',
      type: 'select',
      label: { en: 'Fuel', fr: 'Carburant' },
      description: {
        en: 'The fuel this card ranks the stations for.',
        fr: 'Le carburant pour lequel cette carte classe les stations.',
      },
      default: 'gazole',
      options: FUEL_KEYS.map((key) => ({ value: key, label: FUELS[key].label })),
    },
    {
      key: 'scope',
      type: 'select',
      label: { en: 'Stations', fr: 'Stations' },
      description: {
        en: 'Search around the configured postal code, or rank only the stations you added.',
        fr: 'Chercher autour du code postal configuré, ou classer seulement les stations que vous avez ajoutées.',
      },
      default: SCOPE.AROUND,
      options: [
        {
          value: SCOPE.AROUND,
          label: { en: 'Around my postal code', fr: 'Autour de mon code postal' },
        },
        { value: SCOPE.TRACKED, label: { en: 'My stations only', fr: 'Mes stations seulement' } },
      ],
    },
    {
      key: 'count',
      type: 'select',
      label: { en: 'Stations shown', fr: 'Stations affichées' },
      default: DEFAULT_COUNT,
      options: COUNTS.map((value) => ({ value, label: { en: value, fr: value } })),
    },
  ],
  action_timeout_seconds: 60,
};

/**
 * Read the settings the core sends, falling back on the declared defaults: the
 * core applies them already, but a box saved before a setting existed reaches
 * us without it.
 * @param {Record<string, unknown>} settings
 * @param {object} config normalized integration configuration
 */
function readSettings(settings = {}, config) {
  const fuel = FUEL_KEYS.includes(settings.fuel)
    ? settings.fuel
    : // Not the catalog's first fuel: the one the USER configured, which is the
      // one they are most likely to want ranked.
      (config.fuel_type[0] ?? 'gazole');
  const scope = settings.scope === SCOPE.TRACKED ? SCOPE.TRACKED : SCOPE.AROUND;
  const count = Number(COUNTS.includes(String(settings.count)) ? settings.count : DEFAULT_COUNT);
  return { fuel, scope, count };
}

/**
 * The stations this card ranks, freshest state first.
 * @param {{ config: object, store: object }} context
 * @param {string} scope
 */
async function collectStations({ config, store }, scope) {
  if (scope === SCOPE.TRACKED) {
    const tracked = store.trackedStations;
    const stations = await Promise.all(
      // `getStation` shares one batched request per country, so N stations cost
      // one call whatever N is.
      tracked.map(({ country, stationId }) => store.getStation(country, stationId)),
    );
    return stations.filter(Boolean);
  }
  return store.search(config);
}

/**
 * Build the card.
 * @param {object} _gladys SDK instance (unused: this card reads no device)
 * @param {{ config: object, store: object }} context
 * @param {{ settings?: object, language?: string }} request
 */
export async function getContent(_gladys, { config, store }, { settings, language = 'en' } = {}) {
  const { fuel, scope, count } = readSettings(settings, config);

  if (!isConfigReady(config)) {
    return buildContent(
      [
        text({
          text: {
            en: 'Set a postal code in the integration configuration to see the stations around you.',
            fr: 'Renseignez un code postal dans la configuration de l’intégration pour voir les stations proches.',
          },
        }),
      ],
      // Nothing will change until the user edits the configuration: no point
      // pulling every ten minutes.
      { ttlSeconds: TTL_SECONDS },
    );
  }

  const stations = (await collectStations({ config, store }, scope))
    .filter((station) => Number.isFinite(station.prices?.[fuel]))
    .sort((a, b) => a.prices[fuel] - b.prices[fuel]);

  // Every text we send carries both languages and the core picks: `language`
  // only decides the separators of the numbers we format ourselves.
  const label = { en: fuelLabel(fuel, 'en'), fr: fuelLabel(fuel, 'fr') };

  if (stations.length === 0) {
    return buildContent(
      [
        text({
          text:
            scope === SCOPE.TRACKED
              ? {
                  en: `None of your stations publishes a ${label.en} price.`,
                  fr: `Aucune de vos stations ne publie de prix ${label.fr}.`,
                }
              : {
                  en: `No ${label.en} price found around ${config.postal_code}. Try a wider search radius.`,
                  fr: `Aucun prix ${label.fr} trouvé autour de ${config.postal_code}. Essayez un rayon de recherche plus large.`,
                },
        }),
      ],
      { ttlSeconds: TTL_SECONDS },
    );
  }

  const prices = stations.map((station) => station.prices[fuel]);
  const cheapest = prices[0];
  const average = prices.reduce((sum, price) => sum + price, 0) / prices.length;
  const ranked = stations.slice(0, count);

  return buildContent(
    [
      text({
        variant: 'caption',
        text: {
          en:
            scope === SCOPE.TRACKED
              ? `${label.en} · my stations`
              : `${label.en} · around ${config.postal_code}`,
          fr:
            scope === SCOPE.TRACKED
              ? `${label.fr} · mes stations`
              : `${label.fr} · autour de ${config.postal_code}`,
        },
      }),
      valueTile({
        label: { en: 'Cheapest', fr: 'Le moins cher' },
        value: cheapest,
        unit: PRICE_UNIT,
        color: COLOR.SUCCESS,
      }),
      valueTile({
        label: { en: 'Average', fr: 'Moyenne' },
        // Rounded to the pump's own precision: an average of prices ending in
        // .699 is not more precise than the prices it averages.
        value: Number(average.toFixed(3)),
        unit: PRICE_UNIT,
      }),
      cardList({
        display: 'list',
        items: ranked.map((station, index) => buildItem(station, { fuel, index, language })),
      }),
      button({
        label: { en: 'Refresh', fr: 'Rafraîchir' },
        icon: 'refresh-cw',
        action: { key: 'refresh' },
      }),
    ],
    { ttlSeconds: TTL_SECONDS },
  );
}

/**
 * One row of the ranking. The subtitle carries what decides a stop — price and
 * distance — and the detail panel (opened on tap) the address and the road.
 */
function buildItem(station, { fuel, index, language }) {
  const price = station.prices[fuel];
  const distance = formatDistance(station.distanceKm, language);
  const subtitleParts = [`${formatPrice(price, language)} ${PRICE_UNIT}`, distance].filter(Boolean);
  const url = directionsUrl(station);

  return {
    title: station.name,
    subtitle: subtitleParts.join(' · '),
    // The date the STATION declared that price, left ISO so the core renders it
    // in the reader's locale and timezone.
    date: station.updatedAt?.[fuel],
    badge:
      index === 0
        ? { text: { en: 'Cheapest', fr: 'Moins cher' }, color: COLOR.SUCCESS }
        : undefined,
    description: stationAddress(station),
    links: url ? [{ url, label: { en: 'Directions', fr: 'Itinéraire' } }] : undefined,
  };
}

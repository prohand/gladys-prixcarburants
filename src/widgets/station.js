// -----------------------------------------------------------------------------
// Widget: "My station"
//
// The other half of the need: not "where is it cheapest" but "what does MY
// station charge today". The user picks one of the station devices they added
// (a `source: "devices"` setting, so the core offers them by name), and the
// card shows the prices of the fuels the user configured (or every fuel the
// station sells, or only the device's, as the `fuels` setting says), its
// address, and when it declared those prices.
//
// Every price tile carries TEXT we formatted ourselves, and that is a decision
// rather than an oversight. The tiles used to be declared as `device_feature`
// references for the fuels the user tracks — the core resolved them and the
// dashboard followed them live over the WebSocket — but the front renders a
// bound feature through `DeviceFeatureValueText`, which rounds to ONE decimal:
// a pump price of 1,699 € reached the card as "1,7", while the device page of
// the very same feature showed 1,699. An inline NUMBER is no better, since the
// front formats it with `maximumFractionDigits: 2` ("1,7" again). A pump price
// is written with three decimals on the roadside sign and the third one is the
// whole point of comparing two stations, so the card sends the string
// `1,699 €/L` and nothing downstream can round it.
//
// What that costs is the live binding: the tile now moves when the card is
// re-pulled rather than on the WebSocket. It is paid for — `notifyWidgetsChanged`
// nudges the core at the end of every refresh pass that actually moved a price,
// so the tile still follows the loop within seconds.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { FUELS, FUEL_KEYS, fuelLabel } from '../fuels.js';
import { formatDateTime } from '../text.js';
import { isOutOfStock, outOfStockSince } from '../availability.js';
import { FEATURE, parseDeviceExternalId } from '../devices/fuelStation.js';
import { distanceKm } from '../geo.js';
import { resolveSearchCenter } from '../house.js';
import { COLOR, buildContent, button, statusList, text, valueTile } from './content.js';
import {
  PRICE_UNIT,
  directionsUrl,
  formatDistance,
  formatPrice,
  stationAddress,
} from './format.js';

export const KEY = 'station';

const logger = createLogger({ name: 'widget-station' });

/** How long the core may serve this card from its cache (seconds). */
const TTL_SECONDS = 600;

// The content budget allows 8 components per card. This one always spends
// 1 heading + 1 status + 2 buttons, so 4 price tiles is what is left — and four
// fuels at one station is already more than any driver puts in one tank.
const MAX_TILES = 4;

/** Which fuels get a tile, as the `fuels` setting names them. */
const FUELS_SHOWN = { CONFIGURED: 'configured', DEVICE: 'device', ALL: 'all' };

/**
 * Manifest declaration. Mirrored in `gladys-assistant-integration.json` and
 * checked both ways by test/manifest.test.js — this object is the source.
 */
export const DECLARATION = {
  key: KEY,
  label: { en: 'My station', fr: 'Ma station' },
  description: {
    en: 'The prices of one station you follow, with its address.',
    fr: 'Les prix d’une station que vous suivez, avec son adresse.',
  },
  icon: 'map-pin',
  settings: [
    {
      key: 'device',
      type: 'select',
      // `source: "devices"` is resolved by the core against THIS integration's
      // devices: the user picks a station by name and we receive its
      // `external_id`, from which the country, the station and the fuel are
      // read back (the id carries all three, see devices/fuelStation.js).
      source: 'devices',
      label: { en: 'Station', fr: 'Station' },
      description: {
        en: 'One of the stations you added from the Discovery tab.',
        fr: 'Une des stations que vous avez ajoutées depuis l’onglet Découverte.',
      },
    },
    {
      // A user asked why the card showed every fuel of the station when they
      // follow one: by default it keeps to the fuels of the configuration.
      key: 'fuels',
      type: 'select',
      label: { en: 'Fuels shown', fr: 'Carburants affichés' },
      description: {
        en: 'The fuel of the chosen device always comes first.',
        fr: 'Le carburant de l’appareil choisi est toujours affiché en premier.',
      },
      default: FUELS_SHOWN.CONFIGURED,
      options: [
        {
          value: FUELS_SHOWN.CONFIGURED,
          label: { en: 'My fuels (configuration)', fr: 'Mes carburants (configuration)' },
        },
        {
          value: FUELS_SHOWN.DEVICE,
          label: { en: 'Only the device’s fuel', fr: 'Seulement celui de l’appareil' },
        },
        {
          value: FUELS_SHOWN.ALL,
          label: { en: 'Every fuel of the station', fr: 'Tous ceux de la station' },
        },
      ],
    },
  ],
  action_timeout_seconds: 60,
};

/**
 * Build the card.
 * @param {object} gladys SDK instance, only read for the last price Gladys
 *   holds when the feed publishes none today (see `lastKnownPrice`)
 * @param {{ config: object, store: object }} context
 * @param {{ settings?: object, language?: string }} request `language` only
 *   decides the decimal separator of the prices we format ourselves; every
 *   text of the card carries both languages and the core picks the right one
 */
export async function getContent(
  gladys,
  { config, store, house },
  { settings, language = 'en' } = {},
) {
  const target = parseDeviceExternalId(settings?.device);

  if (!target) {
    return buildContent(
      [
        text({
          text: {
            en: 'Pick one of your stations in the settings of this widget.',
            fr: 'Choisissez une de vos stations dans les réglages de ce widget.',
          },
        }),
      ],
      { ttlSeconds: TTL_SECONDS },
    );
  }

  const station = await store.getStation(target.country, target.stationId);
  if (!station) {
    return buildContent(
      [
        text({
          text: {
            en: 'This station is not published by the open data feed right now.',
            fr: 'Cette station n’est pas publiée par le flux open data en ce moment.',
          },
        }),
      ],
      { ttlSeconds: TTL_SECONDS },
    );
  }

  const { center, source, houseName } = await measureOrigin(station, config, house);
  const fuels = orderFuels({ station, config, target, shown: settings.fuels });
  const url = directionsUrl(station);
  const priced = Number.isFinite(station.prices?.[target.fuel]);
  // The fuel of the picked device always gets its tile, priced or not: without
  // it the card silently showed ANOTHER fuel of the station (a user picked SP98
  // and got GPLc) the day the feed stopped publishing the SP98 price.
  const lastPrice = priced ? null : await lastKnownPrice(gladys, settings.device);

  return buildContent(
    [
      text({ variant: 'heading', text: station.name }),
      ...fuels
        .slice(0, MAX_TILES)
        .map((fuel) =>
          fuel === target.fuel && !priced
            ? buildMissingTile({ fuel, lastPrice, language })
            : buildTile({ station, fuel, language }),
        ),
      statusList(
        buildRows(station, {
          target,
          postalCode: config.postal_code,
          source,
          houseName,
          distance: distanceFrom(station, center),
        }),
      ),
      url
        ? button({
            label: { en: 'Directions', fr: 'Itinéraire' },
            icon: 'navigation',
            link: { url },
          })
        : null,
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
 * The order the tiles are offered in, because only the first four survive:
 * the fuel of the device the user picked — ALWAYS, even with no price today,
 * since it is the one the card was set up for — then the fuels they
 * configured, then (only when the `fuels` setting asks for it) whatever else
 * the station sells. A box saved before the setting existed reaches us without
 * it and gets the default: the configured fuels.
 */
function orderFuels({ station, config, target, shown }) {
  if (shown === FUELS_SHOWN.DEVICE) {
    return [target.fuel];
  }
  const available = FUEL_KEYS.filter((fuel) => Number.isFinite(station.prices?.[fuel]));
  return [
    target.fuel,
    ...config.fuel_type.filter((fuel) => available.includes(fuel)),
    ...(shown === FUELS_SHOWN.ALL ? available : []),
  ].filter((fuel, index, list) => list.indexOf(fuel) === index);
}

/**
 * The last price Gladys holds for the picked device, when the feed publishes
 * none today. `pollDevice` keeps that value on purpose (a missing price is not
 * a hole in the chart), so it is the price the device page shows too.
 *
 * Best effort: the card is still right without it, a dash in place of a price.
 *
 * @param {object} gladys SDK instance
 * @param {string} deviceExternalId the `device` setting of the widget
 * @returns {Promise<number|null>}
 */
async function lastKnownPrice(gladys, deviceExternalId) {
  try {
    const devices = await gladys.getDevices();
    const device = devices?.find((candidate) => candidate.external_id === deviceExternalId);
    const feature = device?.features?.find(
      (candidate) => candidate.external_id === `${deviceExternalId}:${FEATURE.PRICE}`,
    );
    const value = Number(feature?.last_value);
    return feature?.last_value !== null && Number.isFinite(value) && value > 0 ? value : null;
  } catch (err) {
    logger.debug(`Last known price unavailable: ${err.message}`);
    return null;
  }
}

/**
 * Where this card measures from. The house of the configuration centres the
 * SEARCH, but a followed station sits near one house of its own: a user with a
 * house in Noisy and one in Brittany read "410,6 km de Noisy" under the pump
 * 8 km from the Brittany house. With several located houses, the card measures
 * from the nearest one and names it — still the name only, never coordinates.
 */
async function measureOrigin(station, config, house) {
  const origin = await resolveSearchCenter(config, house);
  if (origin.source !== 'house' || typeof house?.all !== 'function') {
    return origin;
  }
  const houses = (await house.all()).filter((candidate) =>
    Number.isFinite(distanceKm(candidate, station)),
  );
  if (houses.length < 2) {
    return origin;
  }
  const nearest = houses.reduce((best, candidate) =>
    distanceKm(candidate, station) < distanceKm(best, station) ? candidate : best,
  );
  return {
    center: { latitude: nearest.latitude, longitude: nearest.longitude },
    source: 'house',
    houseName: nearest.name,
  };
}

/**
 * Where the station is from the origin of the search. Computed here when that
 * origin is the house, because the station of this card usually comes from
 * the batched refresh of the tracked stations, which measures nothing: the
 * card lost its distance row a few minutes after every search.
 */
function distanceFrom(station, center) {
  if (center) {
    return distanceKm(center, station);
  }
  return Number.isFinite(station.distanceKm) ? station.distanceKm : null;
}

/**
 * One price tile, as the TEXT the pump displays.
 *
 * Never a raw number and never a bound feature: both are rounded by the front
 * (two decimals for a number, one for a feature), and `1,7 €/L` is not a price
 * anybody paid. See the note at the top of this file.
 */
function buildTile({ station, fuel, language }) {
  const label = FUELS[fuel]?.label ?? fuelLabel(fuel);
  return valueTile({ label, value: formatPrice(station.prices[fuel], language), unit: PRICE_UNIT });
}

/**
 * The tile of the picked fuel when the feed publishes no price for it today.
 * It carries the last price Gladys holds (the one the device page shows), in
 * the warning color, and the row under the tiles says why it is frozen.
 */
function buildMissingTile({ fuel, lastPrice, language }) {
  const label = FUELS[fuel]?.label ?? fuelLabel(fuel);
  return valueTile({
    label,
    value: lastPrice === null ? '—' : formatPrice(lastPrice, language),
    unit: lastPrice === null ? undefined : PRICE_UNIT,
    color: COLOR.WARNING,
  });
}

/** Why the picked fuel has no price today, as a status row. */
function missingPriceRow(station, fuel) {
  const label = FUELS[fuel]?.label ?? fuelLabel(fuel);
  if (isOutOfStock(station, fuel)) {
    const since = formatDateTime(outOfStockSince(station, fuel));
    return {
      label,
      value: since
        ? { en: `Out of stock since ${since}`, fr: `En rupture depuis le ${since}` }
        : { en: 'Out of stock', fr: 'En rupture' },
      color: COLOR.WARNING,
    };
  }
  return {
    label,
    value: { en: 'No price published today', fr: 'Aucun prix publié aujourd’hui' },
    color: COLOR.WARNING,
  };
}

/** The rows under the tiles: where the station is, and how old its prices are. */
function buildRows(station, { target, postalCode, source, houseName, distance }) {
  const rows = [];
  if (!Number.isFinite(station.prices?.[target.fuel])) {
    rows.push(missingPriceRow(station, target.fuel));
  }
  if (station.brand) {
    rows.push({ label: { en: 'Brand', fr: 'Marque' }, value: station.brand });
  }
  const address = stationAddress(station);
  if (address) {
    rows.push({ label: { en: 'Address', fr: 'Adresse' }, value: address });
  }
  if (Number.isFinite(distance)) {
    // Say WHERE it is measured from, because there are two possible origins:
    // the coordinates of the Gladys house when the user asked for them and
    // located it (`"location": true` in the manifest, src/house.js), and the
    // centre of the postal code area otherwise. "2,3 km" alone would let the
    // reader assume the wrong one.
    rows.push({
      label: { en: 'Distance', fr: 'Distance' },
      value:
        source === 'house'
          ? houseName
            ? {
                en: `${formatDistance(distance, 'en')} from ${houseName}`,
                fr: `${formatDistance(distance, 'fr')} de ${houseName}`,
              }
            : {
                en: `${formatDistance(distance, 'en')} from home`,
                fr: `${formatDistance(distance, 'fr')} de la maison`,
              }
          : {
              en: `${formatDistance(distance, 'en')} from ${postalCode}`,
              fr: `${formatDistance(distance, 'fr')} du ${postalCode}`,
            },
    });
  }
  // The date the station declared the price of the fuel the widget is bound to.
  // Same format as the devices (`08/08/2026 à 21:00`), parsed textually so the
  // container timezone cannot shift the wall-clock time the driver saw.
  const declaredAt = formatDateTime(station.updatedAt?.[target.fuel]);
  if (declaredAt) {
    rows.push({
      label: { en: 'Last price update', fr: 'Dernier relevé' },
      value: declaredAt,
      color: COLOR.NEUTRAL,
    });
  }
  return rows;
}

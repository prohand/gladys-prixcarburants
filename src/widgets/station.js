// -----------------------------------------------------------------------------
// Widget: "My station"
//
// The other half of the need: not "where is it cheapest" but "what does MY
// station charge today". The user picks one of the station devices they added
// (a `source: "devices"` setting, so the core offers them by name), and the
// card shows every fuel that station sells, its address, and when it declared
// those prices.
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

import { FUELS, FUEL_KEYS, fuelLabel } from '../fuels.js';
import { formatDateTime } from '../text.js';
import { parseDeviceExternalId } from '../devices/fuelStation.js';
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

/** How long the core may serve this card from its cache (seconds). */
const TTL_SECONDS = 600;

// The content budget allows 8 components per card. This one always spends
// 1 heading + 1 status + 2 buttons, so 4 price tiles is what is left — and four
// fuels at one station is already more than any driver puts in one tank.
const MAX_TILES = 4;

/**
 * Manifest declaration. Mirrored in `gladys-assistant-integration.json` and
 * checked both ways by test/manifest.test.js — this object is the source.
 */
export const DECLARATION = {
  key: KEY,
  label: { en: 'My station', fr: 'Ma station' },
  description: {
    en: 'Every price of one station you follow, with its address.',
    fr: 'Tous les prix d’une station que vous suivez, avec son adresse.',
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
  ],
  action_timeout_seconds: 60,
};

/**
 * Build the card.
 * @param {object} _gladys SDK instance (unused: every tile is built from the
 *   feed, see the note at the top about the rounding of bound features)
 * @param {{ config: object, store: object }} context
 * @param {{ settings?: object, language?: string }} request `language` only
 *   decides the decimal separator of the prices we format ourselves; every
 *   text of the card carries both languages and the core picks the right one
 */
export async function getContent(
  _gladys,
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

  const { source } = await resolveSearchCenter(config, house);
  const fuels = orderFuels({ station, config, target });
  const url = directionsUrl(station);

  return buildContent(
    [
      text({ variant: 'heading', text: station.name }),
      ...fuels.slice(0, MAX_TILES).map((fuel) => buildTile({ station, fuel, language })),
      statusList(buildRows(station, { target, postalCode: config.postal_code, source })),
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
 * the fuel of the device the user picked, then the fuels they configured, then
 * whatever else the station sells.
 */
function orderFuels({ station, config, target }) {
  const available = FUEL_KEYS.filter((fuel) => Number.isFinite(station.prices?.[fuel]));
  const priority = [target.fuel, ...config.fuel_type];
  return [
    ...priority.filter((fuel) => available.includes(fuel)),
    ...available.filter((fuel) => !priority.includes(fuel)),
  ].filter((fuel, index, list) => list.indexOf(fuel) === index);
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

/** The rows under the tiles: where the station is, and how old its prices are. */
function buildRows(station, { target, postalCode, source }) {
  const rows = [];
  if (station.brand) {
    rows.push({ label: { en: 'Brand', fr: 'Marque' }, value: station.brand });
  }
  const address = stationAddress(station);
  if (address) {
    rows.push({ label: { en: 'Address', fr: 'Adresse' }, value: address });
  }
  if (Number.isFinite(station.distanceKm)) {
    // Say WHERE it is measured from, because there are two possible origins:
    // the coordinates of the Gladys house when the user asked for them and
    // located it (`"location": true` in the manifest, src/house.js), and the
    // centre of the postal code area otherwise. "2,3 km" alone would let the
    // reader assume the wrong one.
    rows.push({
      label: { en: 'Distance', fr: 'Distance' },
      value:
        source === 'house'
          ? {
              en: `${formatDistance(station.distanceKm, 'en')} from home`,
              fr: `${formatDistance(station.distanceKm, 'fr')} de la maison`,
            }
          : {
              en: `${formatDistance(station.distanceKm, 'en')} from ${postalCode}`,
              fr: `${formatDistance(station.distanceKm, 'fr')} du ${postalCode}`,
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

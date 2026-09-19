// -----------------------------------------------------------------------------
// Widget: "My station"
//
// The other half of the need: not "where is it cheapest" but "what does MY
// station charge today". The user picks one of the station devices they added
// (a `source: "devices"` setting, so the core offers them by name), and the
// card shows every fuel that station sells, its address, and when it declared
// those prices.
//
// The interesting part is the binding. A fuel the user actually tracks has a
// Gladys device, hence a price FEATURE — so the tile is declared as a
// `device_feature` reference instead of a value: the core resolves it, the
// dashboard follows it over the WebSocket, and the tile moves the moment the
// refresh loop publishes a new price, without pulling the widget at all. The
// fuels of the same station that the user does NOT track have no feature: those
// tiles carry the value we read from the feed.
// -----------------------------------------------------------------------------

import { FUELS, FUEL_KEYS, fuelLabel } from '../fuels.js';
import { formatDateTime } from '../text.js';
import {
  DEVICE_TYPE,
  FEATURE,
  deviceExternalId,
  parseDeviceExternalId,
  platformId,
} from '../devices/fuelStation.js';
import { COLOR, buildContent, button, statusList, text, valueTile } from './content.js';
import { PRICE_UNIT, directionsUrl, formatDistance, stationAddress } from './format.js';

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
 * @param {object} gladys SDK instance — used to forge feature external ids and
 *   to know which fuels of the station have a device
 * @param {{ config: object, store: object }} context
 * @param {{ settings?: object, language?: string }} request
 */
export async function getContent(gladys, { config, store }, { settings, language = 'en' } = {}) {
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

  const tracked = await trackedFuels(gladys, target);
  const fuels = orderFuels({ station, config, target });
  const url = directionsUrl(station);

  return buildContent(
    [
      text({ variant: 'heading', text: station.name }),
      ...fuels
        .slice(0, MAX_TILES)
        .map((fuel) => buildTile(gladys, { station, target, fuel, tracked })),
      statusList(buildRows(station, { target, language })),
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
 * Which fuels of this station have a Gladys device, hence a live feature.
 *
 * One host API call per widget pull, and only when a station is selected — the
 * core caches the content for a full TTL, so this is a handful of calls a day,
 * not one per dashboard render.
 *
 * @param {object} gladys SDK instance
 * @param {{ country: string, stationId: string }} target
 * @returns {Promise<Set<string>>} the fuel keys the user tracks at this station
 */
async function trackedFuels(gladys, target) {
  const devices = await gladys.getDevices();
  const known = new Set(devices.map((device) => device.external_id));
  return new Set(
    FUEL_KEYS.filter((fuel) => known.has(deviceExternalId(gladys, { ...target, fuel }))),
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
 * One price tile — bound to the device feature when there is one (live), with
 * the value read from the feed otherwise.
 */
function buildTile(gladys, { station, target, fuel, tracked }) {
  const label = FUELS[fuel]?.label ?? fuelLabel(fuel);

  if (tracked.has(fuel)) {
    const ids = gladys.externalIds(
      DEVICE_TYPE,
      platformId({ country: target.country, stationId: target.stationId, fuel }),
    );
    return valueTile({ label, deviceFeature: ids.feature(FEATURE.PRICE) });
  }

  return valueTile({ label, value: station.prices[fuel], unit: PRICE_UNIT });
}

/** The rows under the tiles: where the station is, and how old its prices are. */
function buildRows(station, { target, language }) {
  const rows = [];
  if (station.brand) {
    rows.push({ label: { en: 'Brand', fr: 'Marque' }, value: station.brand });
  }
  const address = stationAddress(station);
  if (address) {
    rows.push({ label: { en: 'Address', fr: 'Adresse' }, value: address });
  }
  if (Number.isFinite(station.distanceKm)) {
    rows.push({
      label: { en: 'Distance', fr: 'Distance' },
      value: formatDistance(station.distanceKm, language),
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

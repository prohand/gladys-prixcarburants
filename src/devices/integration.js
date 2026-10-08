// -----------------------------------------------------------------------------
// Device type: INTEGRATION STATUS
//
// The ONE device of this integration that is not a petrol station. It answers a
// question no station device can: "when did the integration last manage to read
// the open data feed?".
//
// Why it cannot live on a station device: the date a station device carries is
// the date the STATION declared its price. A station that has not moved its
// prices in ten days legitimately shows a ten-day-old date — which says nothing
// about whether the national API is still answering. The read time is a
// property of the integration, identical for every station, so it gets a single
// device shared by all of them rather than being duplicated on each.
//
// It is offered in the Discovery tab like any other device: a user who does not
// care simply never adds it, and the integration works exactly the same.
//
// Feature, read-only:
//   - last_refresh : when the open data feed was last read successfully
//                    ("Dernière lecture des données" — user-facing names of
//                    this device are in French, the language of its users).
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
} from '@gladysassistant/integration-sdk';
import { featureState, publishStates } from '../statePublisher.js';
import { formatInstant } from '../text.js';

export const DEVICE_TYPE = 'integration';

const logger = createLogger({ name: DEVICE_TYPE });

export const FEATURE = {
  LAST_REFRESH: 'last_refresh',
};

// There is exactly one such device, so its platform id is a constant rather
// than something derived from the configuration: changing the country or the
// postal code must not orphan it.
const PLATFORM_ID = 'status';

/**
 * @param {object} gladys SDK instance
 * @returns {string} external id of the (single) integration device
 */
export function integrationExternalId(gladys) {
  return gladys.externalIds(DEVICE_TYPE, PLATFORM_ID).device;
}

/**
 * Is this external id the integration device? Used to route a poll, and to keep
 * `parseTargets` (which only knows about stations) free of special cases.
 * @param {string} externalId
 */
export function isIntegrationDevice(gladys, externalId) {
  return String(externalId ?? '') === integrationExternalId(gladys);
}

/**
 * Discovery payload of the integration device.
 *
 * No `poll_frequency`, for the same reason as the station devices: Gladys' enum
 * tops out at one minute (see src/devices/fuelStation.js). The state is
 * published at the end of every refresh pass instead.
 *
 * @param {object} gladys SDK instance
 */
export function buildIntegrationDevice(gladys) {
  const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_ID);

  return {
    // In French, like the audience of a French open data feed. A device name is
    // a plain string in Gladys — no `{ en, fr }` object like the action
    // results — so it is picked once here, and the user renames it if they want.
    name: 'Prix carburants - Mise à jour des données',
    external_id: ids.device,
    features: [
      {
        name: 'Dernière lecture des données',
        external_id: ids.feature(FEATURE.LAST_REFRESH),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        // NOT NULL in Gladys even for a text feature: omitting them fails the
        // device creation with "HTTP 422 - min cannot be null".
        min: 0,
        max: 0,
        read_only: true,
        has_feedback: false,
        // A timestamp curve would say nothing; the tile shows the last value.
        keep_history: false,
      },
    ],
  };
}

/**
 * The state saying when the feed was last read — none when the user did not
 * add the device, or when no provider call has succeeded yet (a fresh
 * container that has never reached the API must not claim a read time).
 * Built, not sent: a refresh pass sends it in the same batch as the prices.
 *
 * @param {object} gladys SDK instance
 * @param {{ store: object, devices?: Array<{ external_id: string }> }} context
 *   `devices` is the list Gladys already handed us, so publishing the status
 *   costs no extra round-trip.
 * @returns {Array<object>} zero or one state
 */
export function integrationStates(gladys, { store, devices = [] }) {
  const externalId = integrationExternalId(gladys);
  if (!devices.some((device) => device.external_id === externalId)) {
    return [];
  }

  const lastRefresh = formatInstant(store.lastFetchAt);
  if (!lastRefresh) {
    logger.debug('The feed has never been read successfully yet: nothing to publish');
    return [];
  }

  const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_ID);
  return [featureState(ids.feature(FEATURE.LAST_REFRESH), { text: lastRefresh })];
}

/**
 * Publish when the feed was last read, right away (see `integrationStates`).
 *
 * @param {object} gladys SDK instance
 * @param {{ store: object, devices?: Array<{ external_id: string }> }} context
 * @returns {Promise<string|null>} the published text, or null when nothing was
 */
export async function publishIntegrationState(gladys, context) {
  const states = integrationStates(gladys, context);
  if (states.length === 0) {
    return null;
  }
  await publishStates(gladys, states);
  return states[0].text;
}

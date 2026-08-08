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
//   - last_refresh : when the open data feed was last read successfully.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
} from '@gladysassistant/integration-sdk';
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
    name: 'Fuel prices - Data update',
    external_id: ids.device,
    features: [
      {
        name: 'Last data refresh',
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
 * Publish when the feed was last read — a no-op when the user did not add the
 * device, or when no provider call has succeeded yet (a fresh container that
 * has never reached the API must not claim a read time).
 *
 * @param {object} gladys SDK instance
 * @param {{ store: object, devices?: Array<{ external_id: string }> }} context
 *   `devices` is the list Gladys already handed us, so publishing the status
 *   costs no extra round-trip.
 * @returns {Promise<string|null>} the published text, or null when nothing was
 */
export async function publishIntegrationState(gladys, { store, devices = [] }) {
  const externalId = integrationExternalId(gladys);
  if (!devices.some((device) => device.external_id === externalId)) {
    return null;
  }

  const lastRefresh = formatInstant(store.lastFetchAt);
  if (!lastRefresh) {
    logger.debug('The feed has never been read successfully yet: nothing to publish');
    return null;
  }

  const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_ID);
  await gladys.publishState(ids.feature(FEATURE.LAST_REFRESH), { text: lastRefresh });
  return lastRefresh;
}

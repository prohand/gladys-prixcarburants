// -----------------------------------------------------------------------------
// The one way this integration publishes device states to Gladys.
//
// The host API takes at most 100 states per request and 300 states a minute
// per integration, answering 429 beyond. A refresh pass used to send ONE
// request per feature — two per station device — so fifty devices were a
// hundred requests in a burst, and the 429s that followed lost prices with
// nothing to say so but an error line per device.
//
// Now a pass builds its states first and sends them here: one request per 100
// states. A 429 is waited out ONCE and the same chunk sent again; a second
// refusal is a real failure and propagates to the caller.
//
// The wait is the length of the limit's window, not a `Retry-After`: the SDK
// (0.14.0) turns every non-2xx into a `GladysApiError` that carries the status
// and the Gladys error code, never the response headers.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'states' });

/** Contract C.3: the host API refuses a bigger batch outright. */
export const MAX_STATES_PER_REQUEST = 100;

/** How long a 429 is waited out: the window of the 300 states/min limit. */
export const RATE_LIMIT_WAIT_MS = 60_000;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One state in the shape the host API takes: a numeric `state` OR a `text`,
 * never both.
 * @param {string} featureExternalId
 * @param {number|{ text: string }} value
 * @returns {{ device_feature_external_id: string, state?: number, text?: string }}
 */
export function featureState(featureExternalId, value) {
  if (value !== null && typeof value === 'object') {
    return { device_feature_external_id: featureExternalId, text: value.text };
  }
  return { device_feature_external_id: featureExternalId, state: value };
}

/**
 * Send states in chunks of at most 100, waiting out one 429 per chunk.
 *
 * @param {object} gladys SDK instance (`publishStates`)
 * @param {Array<object>} states built with `featureState`
 * @param {{ sleep?: (ms: number) => Promise<void> }} [options] `sleep` is the
 *   seam the tests use so a scripted 429 costs no real minute
 * @returns {Promise<number>} how many states were sent
 */
export async function publishStates(gladys, states, { sleep = realSleep } = {}) {
  for (let i = 0; i < states.length; i += MAX_STATES_PER_REQUEST) {
    const chunk = states.slice(i, i + MAX_STATES_PER_REQUEST);
    try {
      await gladys.publishStates(chunk);
    } catch (err) {
      if (err?.status !== 429) {
        throw err;
      }
      logger.warn(
        `Gladys rate-limited ${chunk.length} state(s): retrying once in ${RATE_LIMIT_WAIT_MS / 1000}s`,
      );
      await sleep(RATE_LIMIT_WAIT_MS);
      await gladys.publishStates(chunk);
    }
  }
  return states.length;
}

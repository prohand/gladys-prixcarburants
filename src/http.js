// -----------------------------------------------------------------------------
// The one way this integration reads an external open data API.
//
// Four modules talk to the outside world (the price feed, the price history,
// the reference datasets for the names, the Base Adresse Nationale), and each
// used to carry its own copy of "fetch with a timeout, throw on a non-2xx,
// parse the JSON". None of them retried: one 502 from a portal behind a load
// balancer, one 429 because a neighbour hammered the same Opendatasoft tenant,
// and a whole refresh pass — or the search a dashboard card waits on — failed
// for a hiccup that a second request a moment later would have gone through.
//
// So: ONE retry, never more, on what a retry can fix — a 429, a 5xx, a request
// that never reached the server. Not on a 4xx (the request is wrong, asking
// again changes nothing) and not on a timeout (the server is slow, and a second
// full timeout would push a widget pull past the core's ack deadline). The wait
// honours `Retry-After` but is capped SHORT: a card waits on these requests
// behind a 9 s deadline (src/widgets/index.js), so a server asking for a
// minute gets the failure it asked for instead of a dead card.
//
// What is logged is the URL with the coordinates of every `POINT(...)` blanked:
// the search circle may be centred on the user's house, and coordinates are
// personal data that never reach a log line.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const defaultLogger = createLogger({ name: 'http' });

/** Longest wait honoured before the retry, whatever `Retry-After` asks for. */
export const MAX_RETRY_WAIT_MS = 5_000;

/** Wait before the retry when the server gave no `Retry-After`. */
export const DEFAULT_RETRY_WAIT_MS = 1_000;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sleep = realSleep;

/**
 * Replace the wait between a failure and its retry — the seam the tests use so
 * a scripted 503 costs no real second. Returns the previous function so a test
 * can put it back.
 * @param {(ms: number) => Promise<void>} [fn] omitted: back to the real timer
 * @returns {(ms: number) => Promise<void>}
 */
export function setRetrySleep(fn = realSleep) {
  const previous = sleep;
  sleep = fn;
  return previous;
}

/**
 * The URL as it may appear in a log: every `POINT(lon lat)` is blanked, whether
 * the query string is percent-encoded or not.
 * @param {URL|string} url
 * @returns {string}
 */
export function redactUrl(url) {
  let text = String(url);
  try {
    text = decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    // A malformed escape: redact the raw string, it is only a log line.
  }
  return text.replace(/POINT\s*\([^)]*\)/gi, 'POINT(…)');
}

/**
 * How long the server asked us to wait, in ms, capped; `null` when it did not
 * say (or said something unreadable).
 * @param {{ headers?: { get?: (name: string) => string|null } }} response
 * @returns {number|null}
 */
export function retryAfterMs(response) {
  const raw = response?.headers?.get?.('retry-after');
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return null;
  }
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms)) {
    return null;
  }
  return Math.min(MAX_RETRY_WAIT_MS, Math.max(0, ms));
}

/** A failure a second attempt can fix: rate limited, server error, no answer. */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/** A request that never got an answer — but not one we gave up on ourselves. */
function isNetworkError(err) {
  return err?.name !== 'TimeoutError' && err?.name !== 'AbortError';
}

/**
 * GET a JSON document, retrying once on a 429, a 5xx or a network error.
 *
 * @param {URL|string} url
 * @param {{ timeoutMs: number, label?: string, headers?: object,
 *   logger?: object }} options
 *   `label` prefixes the error message (`prix-carburants API HTTP 500 (…)`),
 *   which is what the callers already logged and the tests assert.
 * @returns {Promise<any>} the parsed body
 * @throws {Error} with `status` set when the server answered an error twice
 *   (or once, for a non-retryable one)
 */
export async function fetchJson(url, { timeoutMs, label = '', headers, logger = defaultLogger }) {
  const prefix = label ? `${label} ` : '';
  for (let attempt = 1; ; attempt += 1) {
    const last = attempt >= 2;
    logger.debug(`Request -> ${redactUrl(url)}${last ? ' (retry)' : ''}`);

    let response;
    try {
      response = await fetch(url, {
        ...(headers ? { headers } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (last || !isNetworkError(err)) {
        throw err;
      }
      logger.debug(`${prefix}request failed (${err.message}), retrying once`);
      await sleep(DEFAULT_RETRY_WAIT_MS);
      continue;
    }

    if (response.ok) {
      return response.json();
    }
    if (!last && isRetryableStatus(response.status)) {
      const wait = retryAfterMs(response) ?? DEFAULT_RETRY_WAIT_MS;
      logger.debug(`${prefix}HTTP ${response.status}, retrying once in ${wait} ms`);
      await sleep(wait);
      continue;
    }
    // Propagate: each caller decides between keeping what it had and reporting
    // the failure to the user.
    const error = new Error(`${prefix}HTTP ${response.status} (${response.statusText})`);
    error.status = response.status;
    throw error;
  }
}

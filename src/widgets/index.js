// -----------------------------------------------------------------------------
// Dashboard widgets: registry and wiring.
//
// The mechanism (GladysAssistant/Gladys#3109): an integration declares its
// widgets in the manifest — identity only (key, label, icon, per-instance
// settings) — and produces their CONTENT at runtime, as a tree of components in
// the core's own vocabulary. Gladys validates it, bounds it, caches it for the
// TTL we ask for, and renders it in its own canonical order. No HTML, no CSS,
// no script ever leaves this container: the card cannot look out of place, and
// a Gladys that gains a new theme takes our widgets with it.
//
// Three handlers, all registered before `connect()` like every other one:
//   - `onWidgetGet(key, cb)`      the pull: build the card;
//   - `onWidgetAction(key, cb)`   a button was tapped;
//   - `requestWidgetRefresh(key)` the nudge, the only thing we PUSH: "re-pull
//                                 me", carrying no data at all.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { buildContent, text } from './content.js';
import * as bestPrices from './bestPrices.js';
import * as station from './station.js';

const logger = createLogger({ name: 'widgets' });

/**
 * How long a pull may take before we answer WITHOUT it.
 *
 * The core acks `widget.get` under 15 seconds (`WIDGET_GET_TIMEOUT_MS`) and a
 * missed ack is not a slow card: the front shows "widget data unavailable",
 * drops the content it had and schedules NO retry — the card stays dead until
 * the user taps "Retry" or reloads the dashboard. That is the failure a user
 * reported after an update, and reinstalling the integration "fixed" it only
 * because it remounted the cards.
 *
 * Fifteen seconds is easy to miss on a cold container: the two cards pull at
 * the same time, each search walks concentric circles (one request per ring,
 * 15 s timeout each), the postal code may need geocoding and the station names
 * come from two more datasets. None of it is cached yet, and none of it is
 * wrong — it is simply longer than the deadline.
 *
 * So the deadline is OURS, and it is short enough that the answer always
 * arrives: past it the card is served warming (a sentence and a short TTL), the
 * real work keeps running in the background, and the re-pull a few seconds
 * later is served from the store cache. A card that fills itself on the second
 * pull beats a card that has to be reinstalled.
 */
const PULL_DEADLINE_MS = 9000;

/** TTL of the warming card: the core re-pulls just after, cache warm by then. */
const WARMING_TTL_SECONDS = 15;

/**
 * The card served when the data is not there yet. Deliberately not an error:
 * nothing failed, the feed is simply slower than the ack deadline.
 */
function warmingContent() {
  return buildContent(
    [
      text({
        text: {
          en: 'Reading the open data feed… this card fills itself in a few seconds.',
          fr: 'Lecture du flux open data… cette carte se remplit dans quelques secondes.',
        },
      }),
    ],
    { ttlSeconds: WARMING_TTL_SECONDS },
  );
}

/**
 * Resolve `promise`, or `null` if it is still running after `deadlineMs`.
 *
 * The promise is NOT cancelled: it is exactly the work whose result the next
 * pull wants in the store cache. It is only detached — with a `catch` of its
 * own, since nobody awaits it any more and an unhandled rejection would take
 * the container down.
 *
 * The timer is a real one, never unref'd: it is the deadline of a call somebody
 * is awaiting, so it must keep the loop alive exactly as the pull would. It is
 * cleared the moment the pull settles, so it outlives nothing.
 *
 * @param {Promise<T>} promise
 * @param {number} deadlineMs
 * @param {{ setTimer?: Function, clearTimer?: Function }} [timers] the seam the
 *   tests use in place of the real clock
 * @returns {Promise<T|null>}
 * @template T
 */
function withDeadline(promise, deadlineMs, { setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimer(() => resolve(null), deadlineMs);
  });
  return Promise.race([
    promise.then(
      (value) => {
        clearTimer(timer);
        return value;
      },
      (err) => {
        clearTimer(timer);
        throw err;
      },
    ),
    expired,
  ]);
}

/** Widget key -> module. Key order is the order of the manifest declarations. */
export const WIDGETS = {
  [bestPrices.KEY]: bestPrices,
  [station.KEY]: station,
};

export const WIDGET_KEYS = Object.keys(WIDGETS);

/**
 * The `widgets` array of the manifest, built from the modules themselves.
 * test/manifest.test.js asserts the manifest equals this, so the declaration
 * and the code can never drift apart.
 */
export function buildWidgetManifest() {
  return WIDGET_KEYS.map((key) => WIDGETS[key].DECLARATION);
}

/**
 * Build the content of one widget.
 * @param {object} gladys SDK instance
 * @param {{ config: object, store: object }} context
 * @param {string} key widget key, as declared in the manifest
 * @param {{ settings?: object, language?: string, units?: string }} [request]
 *   `units` is ignored: a fuel price is published per litre in euros by the
 *   open data feed itself, and converting it to gallons would invent a number
 *   no pump in the country displays.
 * @param {{ deadlineMs?: number, setTimer?: Function, clearTimer?: Function }} [options]
 *   the seams the tests use in place of the real clock
 */
export async function getWidgetContent(gladys, context, key, request = {}, options = {}) {
  const widget = WIDGETS[key];
  if (!widget) {
    // Never silently return an empty card: an unknown key means the manifest
    // and the code disagree, which the user should see as an error.
    throw new Error(`Unknown widget "${key}"`);
  }
  const { deadlineMs = PULL_DEADLINE_MS, ...timers } = options;
  const pull = widget.getContent(gladys, context, request);
  // Detached from the race: whichever side wins, this promise must not be able
  // to reject into nobody's hands.
  pull.catch((err) => logger.debug(`Widget "${key}" failed after the deadline: ${err.message}`));

  const content = await withDeadline(pull, deadlineMs, timers);
  if (!content) {
    logger.info(
      `Widget "${key}": the feed did not answer within ${deadlineMs} ms, ` +
        'serving a warming card (the pull keeps running and fills the cache)',
    );
    return warmingContent();
  }
  logger.debug(`Widget "${key}": ${content.components.length} component(s)`);
  return content;
}

/**
 * Run a widget button.
 *
 * Both widgets offer the same one — "Refresh" — and it means the same thing as
 * the Configuration screen's button: drop the cache so the next read really
 * hits the open data API. The core invalidates its own widget cache after a
 * successful action and re-pulls, so the card redraws with fresh prices on its
 * own; we only have to make sure the next pull is not served from OUR cache.
 *
 * @param {object} gladys SDK instance
 * @param {{ config: object, store: object }} context
 * @param {string} key widget key
 * @param {string} actionKey action declared in the content we last returned
 */
export async function runWidgetAction(gladys, { store }, key, actionKey) {
  if (actionKey !== 'refresh') {
    throw new Error(`Unknown action "${actionKey}" for widget "${key}"`);
  }
  store.invalidate();
  logger.info(`Widget "${key}": prices invalidated, the next read will hit the feed`);
  return { en: 'Prices refreshed.', fr: 'Prix rafraîchis.' };
}

/**
 * Tell Gladys that the cards may have changed — after a refresh pass published
 * new prices, typically.
 *
 * Fire-and-forget by contract: no data travels, the core simply drops its
 * cached content and asks for it again, and it rate-limits the nudge to one per
 * ten seconds per widget. Nothing here needs to be awaited or retried.
 *
 * @param {object} gladys SDK instance
 */
export function notifyWidgetsChanged(gladys) {
  for (const key of WIDGET_KEYS) {
    try {
      gladys.requestWidgetRefresh(key);
    } catch (err) {
      // A nudge that fails costs one TTL of freshness, never a refresh pass.
      logger.debug(`Widget nudge failed for "${key}": ${err.message}`);
    }
  }
}

/**
 * Register the widget handlers.
 *
 * @param {object} gladys SDK instance
 * @param {() => { config: object, store: object }} getContext the context is
 *   read at CALL time, not at registration time: the configuration is
 *   hot-reloaded (`onConfigUpdated`) and a handler closing over the old object
 *   would keep serving the old postal code.
 */
export function registerWidgets(gladys, getContext) {
  for (const key of WIDGET_KEYS) {
    gladys.onWidgetGet(key, (request) => getWidgetContent(gladys, getContext(), key, request));
    gladys.onWidgetAction(key, (actionKey) =>
      runWidgetAction(gladys, getContext(), key, actionKey),
    );
  }
  logger.info(`${WIDGET_KEYS.length} dashboard widget(s) registered: ${WIDGET_KEYS.join(', ')}`);
}

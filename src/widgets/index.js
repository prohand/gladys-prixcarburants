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
//
// Registration is guarded by a capability check on purpose. The widget contract
// is newer than the SDK version this integration pins, and an integration that
// crashes at boot on an older SDK is worse than one that simply has no widget:
// everything else keeps working, and the log line says what is missing.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import * as bestPrices from './bestPrices.js';
import * as station from './station.js';

const logger = createLogger({ name: 'widgets' });

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
 */
export async function getWidgetContent(gladys, context, key, request = {}) {
  const widget = WIDGETS[key];
  if (!widget) {
    // Never silently return an empty card: an unknown key means the manifest
    // and the code disagree, which the user should see as an error.
    throw new Error(`Unknown widget "${key}"`);
  }
  const content = await widget.getContent(gladys, context, request);
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
  if (typeof gladys.requestWidgetRefresh !== 'function') {
    return;
  }
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
 * Register the widget handlers, if this SDK knows about widgets.
 *
 * @param {object} gladys SDK instance
 * @param {() => { config: object, store: object }} getContext the context is
 *   read at CALL time, not at registration time: the configuration is
 *   hot-reloaded (`onConfigUpdated`) and a handler closing over the old object
 *   would keep serving the old postal code.
 * @returns {boolean} whether the handlers could be registered
 */
export function registerWidgets(gladys, getContext) {
  if (typeof gladys.onWidgetGet !== 'function') {
    logger.info(
      'This SDK does not support dashboard widgets yet: the integration runs without them.',
    );
    return false;
  }

  for (const key of WIDGET_KEYS) {
    gladys.onWidgetGet(key, (request) => getWidgetContent(gladys, getContext(), key, request));
    if (typeof gladys.onWidgetAction === 'function') {
      gladys.onWidgetAction(key, (actionKey) =>
        runWidgetAction(gladys, getContext(), key, actionKey),
      );
    }
  }
  logger.info(`${WIDGET_KEYS.length} dashboard widget(s) registered: ${WIDGET_KEYS.join(', ')}`);
  return true;
}

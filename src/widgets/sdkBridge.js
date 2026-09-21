// -----------------------------------------------------------------------------
// Widget messages, answered without SDK support.
//
// Why this file exists: the widget contract (GladysAssistant/Gladys#3109) is
// live in the core before it is in `@gladysassistant/integration-sdk` (0.13.0,
// the latest, knows nothing about widgets). Its message dispatcher ends with
//
//     default:  // unknown types are ignored silently for forward compatibility
//
// so a core asking `external-integration.widget.get` gets NO ack at all, and
// the card shows "data unavailable" after the 15 s deadline — which is exactly
// what a user sees today.
//
// So we answer those four messages ourselves, on the SDK's own socket:
// it stays the one connection, with the SDK's authentication, reconnection and
// backoff; we only add a second `message` listener that handles the types the
// SDK does not know yet and ignores every other one.
//
// This is a COMPATIBILITY SHIM, and it is written to disappear: the moment the
// SDK exposes `onWidgetGet`, `registerWidgets` uses the real API and never
// installs the bridge (see index.js). The only SDK internals it touches are
// `gladys.ws` (the WebSocket) and the wire format of `command-result`, both of
// which are the documented contract between Gladys and any integration.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'widget-bridge' });

/** The message types of the widget contract (section 10 of the spec). */
export const WIDGET_MESSAGE = {
  GET: 'external-integration.widget.get',
  GET_IMAGE: 'external-integration.widget.get-image',
  ACTION: 'external-integration.widget.action',
  REFRESH: 'external-integration.widget.refresh',
};

/** The ack every command travels back on. */
const COMMAND_RESULT = 'external-integration.command-result';

// The core waits 15 s for the ack of a widget command. Answering just under
// that turns a silent timeout ("data unavailable", no explanation) into a
// sentence the user can act on — the open data API being slow is exactly the
// case this integration must name rather than hide.
const ACK_DEADLINE_MS = 13_000;

/** Marks a socket we already listen to, so a reconnect never doubles up. */
const BRIDGED = Symbol.for('prix-carburants.widget-bridge');

/**
 * Send a message on the SDK's socket, if it is open.
 * @returns {boolean} whether it could be sent
 */
function send(gladys, type, payload) {
  const ws = gladys.ws;
  // 1 === WebSocket.OPEN, spelled out so this file needs no `ws` import.
  if (!ws || ws.readyState !== 1) {
    logger.debug(`Websocket not open, dropping ${type}`);
    return false;
  }
  ws.send(JSON.stringify({ type, payload }));
  return true;
}

/**
 * Answer a command the way the SDK would: success with an optional `data`,
 * or failure with the error message, which the core displays under the card.
 */
function ack(gladys, messageId, result) {
  send(gladys, COMMAND_RESULT, { message_id: messageId, ...result });
}

/**
 * Resolve `promise`, or reject with a readable reason if it takes longer than
 * the core is willing to wait.
 * @param {Promise} promise
 * @param {string} what the command being run, for the message
 */
function withDeadline(promise, what) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${what} took more than ${ACK_DEADLINE_MS / 1000}s (the open data API did not answer in time)`,
          ),
        ),
      ACK_DEADLINE_MS,
    );
    // Never keep the container alive just for this timer.
    timer?.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Handle one incoming message. Anything that is not a widget command is left
 * to the SDK, which receives it on its own listener.
 *
 * @param {object} gladys SDK instance
 * @param {{ getContent: Function, runAction: Function }} handlers
 * @param {unknown} raw the frame, as the `ws` library hands it over
 */
async function handleMessage(gladys, handlers, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return; // not JSON: the SDK logs it, we stay quiet
  }

  const { type, payload = {} } = message ?? {};
  if (type !== WIDGET_MESSAGE.GET && type !== WIDGET_MESSAGE.ACTION) {
    // `widget.get-image` is never sent to us: our cards declare no image key,
    // and the core only ever asks for keys it saw in a content we returned.
    return;
  }

  const messageId = payload.message_id;
  try {
    if (type === WIDGET_MESSAGE.GET) {
      const content = await withDeadline(
        handlers.getContent(payload.key, {
          settings: payload.settings,
          language: payload.language,
          units: payload.units,
        }),
        `widget "${payload.key}"`,
      );
      ack(gladys, messageId, { success: true, data: { content } });
      return;
    }
    const result = await withDeadline(
      handlers.runAction(payload.key, payload.action_key, payload.params, {
        settings: payload.settings,
      }),
      `action "${payload.action_key}"`,
    );
    ack(gladys, messageId, { success: true, data: { message: result } });
  } catch (err) {
    // The core shows this string under the generic "unavailable" message, so
    // it is worth being specific: "No station found around 35000" beats
    // "unknown error" for someone who just added the card.
    logger.error(`Widget command ${type} failed`, err);
    ack(gladys, messageId, { success: false, error: err.message });
  }
}

/**
 * Start answering widget commands on the SDK's socket.
 *
 * Attaching on every `connected` event covers reconnections: the SDK opens a
 * NEW socket each time, and the old listener dies with the old socket.
 *
 * @param {object} gladys SDK instance
 * @param {{ getContent: Function, runAction: Function }} handlers
 */
export function bridgeWidgetMessages(gladys, handlers) {
  const attach = () => {
    const ws = gladys.ws;
    if (!ws || ws[BRIDGED]) {
      return;
    }
    ws[BRIDGED] = true;
    ws.on('message', (raw) => {
      handleMessage(gladys, handlers, raw).catch((err) =>
        // handleMessage acks its own failures; reaching here means the ack
        // itself failed, which must not take the container down.
        logger.error('Widget message handling failed', err),
      );
    });
    logger.debug('Widget commands are now answered on the SDK socket');
  };

  gladys.on('connected', attach);
  // The socket may already be up when this runs (a re-registration, a test).
  attach();
}

/**
 * The freshness nudge, `external-integration.widget.refresh`: fire-and-forget,
 * no `message_id`, no ack. The core drops its cached content for that widget
 * and asks every open dashboard to refetch. Rate-limited core-side to one per
 * ten seconds per widget, so a dropped one costs nothing.
 *
 * @param {object} gladys SDK instance
 * @param {string} key widget key
 */
export function sendWidgetRefresh(gladys, key) {
  send(gladys, WIDGET_MESSAGE.REFRESH, { key });
}

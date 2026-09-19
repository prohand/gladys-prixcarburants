// -----------------------------------------------------------------------------
// The dashboard widget content vocabulary.
//
// A widget does NOT draw anything: it describes WHAT to show and Gladys decides
// HOW (GladysAssistant/Gladys#3109, "dashboard widgets declared by
// integrations"). The core normalizes every payload it receives — unknown
// fields dropped, strings truncated, components beyond the budget dropped in
// content order — so anything we send that exceeds a bound is silently trimmed
// on the dashboard.
//
// This module therefore applies the SAME bounds on our side, which buys two
// things: the card we design is the card the user sees (no surprise trimming),
// and a failing unit test is how we learn about a violation instead of an empty
// slot on someone's wall panel.
//
// Bounds and budget below are the spec's, quoted next to each constant.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { cleanText } from '../text.js';

const logger = createLogger({ name: 'widget-content' });

/** Content envelope version we speak. Bumped only by a breaking core change. */
export const CONTENT_VERSION = 1;

/** Semantic colors: the only styling an integration may ask for. */
export const COLOR = {
  NEUTRAL: 'neutral',
  PRIMARY: 'primary',
  SUCCESS: 'success',
  WARNING: 'warning',
  DANGER: 'danger',
  INFO: 'info',
};

/** Per-field character bounds (per language value), from section 4 of the spec. */
export const LIMITS = {
  HEADING: 40,
  CAPTION: 80,
  BODY: 300,
  TILE_VALUE: 12,
  TILE_LABEL: 24,
  UNIT: 6,
  STATUS_LABEL: 40,
  STATUS_VALUE: 40,
  STATUS_ITEMS: 10,
  CARD_TITLE: 60,
  CARD_SUBTITLE: 60,
  CARD_DESCRIPTION: 2000,
  CARD_BADGE: 16,
  CARD_LINKS: 3,
  CARD_ITEMS_LIST: 8,
  CARD_ITEMS_GRID: 12,
  LINK_LABEL: 24,
  BUTTON_LABEL: 24,
  TTL_MIN: 10,
  TTL_MAX: 3600,
};

/** The content budget of section 5: how much fits in one card, and how often. */
export const BUDGET = {
  COMPONENTS: 8, // a card is read at a glance; beyond, it is a page
  FOCAL: 1, // one card, one subject (chart | card-list | image | status)
  TILES: 6, // value | gauge, rendered as one wrapping row
  TEXTS: 2, // of which at most one `body`
  BODY_TEXTS: 1,
  STATUS: 1,
  BUTTONS: 4,
};

const TILE_TYPES = new Set(['value', 'gauge']);
// `status` participates in the focal budget: the spec counts a second status
// list as a second focal component.
const FOCAL_TYPES = new Set(['chart', 'card-list', 'image', 'status']);

/**
 * Trim a text to its bound, per language value.
 *
 * Every text field of the vocabulary accepts a plain string OR a
 * multi-language object (`en` required, used as the fallback). We build almost
 * everything as `{ en, fr }` so the core can render the card in the language of
 * the user looking at it, whoever opened the dashboard.
 *
 * @param {unknown} value string or `{ en, fr }`
 * @param {number} max characters allowed per language
 * @returns {string|{ en: string, fr?: string }|undefined} `undefined` when there
 *   is nothing to show, so the field can simply be omitted
 */
export function boundedText(value, max) {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [lang, translation] of Object.entries(value)) {
      const bounded = boundedText(translation, max);
      if (bounded !== undefined) {
        out[lang] = bounded;
      }
    }
    return out.en === undefined ? undefined : out;
  }
  // Control characters reach the dashboard as invisible junk (the core strips
  // them too). Written character by character rather than as a regex range:
  // `no-control-regex` is right to refuse the literal one.
  const stripped = [...String(value)]
    .map((char) => (char < ' ' || char === '\u007f' ? ' ' : char))
    .join('');
  const text = cleanText(stripped);
  if (text.length === 0) {
    return undefined;
  }
  // The core truncates with an ellipsis; doing it here keeps the cut where we
  // chose it rather than mid-word at the byte the core happened to reach.
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Drop the keys whose value is `undefined`, so the JSON we send stays minimal. */
function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/**
 * A text component. `heading` and `caption` are single-line, `body` is the one
 * place a sentence belongs (an empty or degraded state, typically).
 * @param {{ text: unknown, variant?: 'heading'|'body'|'caption' }} options
 */
export function text({ text: value, variant = 'body' }) {
  const max =
    variant === 'heading' ? LIMITS.HEADING : variant === 'caption' ? LIMITS.CAPTION : LIMITS.BODY;
  const bounded = boundedText(value, max);
  if (bounded === undefined) {
    return null;
  }
  return compact({ type: 'text', variant, text: bounded });
}

/**
 * A value tile: one short value, one unit, one label.
 *
 * Two ways to fill it, and the second is the interesting one:
 *   - `value` + `unit`: a number WE computed (the cheapest price around, an
 *     average) — data the core has no device for;
 *   - `deviceFeature`: the `external_id` of one of OUR features, which the core
 *     resolves within the tenant and the frontend then follows LIVE over the
 *     WebSocket. A price tile bound this way moves the instant the refresh loop
 *     publishes a new state, with no widget pull at all.
 *
 * @param {{ label?: unknown, value?: number|string, unit?: unknown,
 *   deviceFeature?: string, icon?: string, color?: string }} options
 */
export function valueTile({ label, value, unit, deviceFeature, icon, color }) {
  const hasInlineValue = typeof value === 'number' ? Number.isFinite(value) : Boolean(value);
  if (!hasInlineValue && !deviceFeature) {
    // A tile with neither a value nor a binding is dropped by the core anyway.
    return null;
  }
  return compact({
    type: 'value',
    label: boundedText(label, LIMITS.TILE_LABEL),
    // A bound tile takes its value and its unit from the feature.
    value: deviceFeature
      ? undefined
      : typeof value === 'number'
        ? value
        : boundedText(value, LIMITS.TILE_VALUE),
    unit: deviceFeature ? undefined : boundedText(unit, LIMITS.UNIT),
    device_feature: deviceFeature,
    icon,
    color,
  });
}

/**
 * A list of label / value rows with a colored dot — the "state of things" slot.
 * @param {Array<{ label: unknown, value: unknown, icon?: string, color?: string }>} rows
 */
export function statusList(rows) {
  const items = rows
    .map((row) =>
      compact({
        label: boundedText(row.label, LIMITS.STATUS_LABEL),
        value:
          typeof row.value === 'number' ? row.value : boundedText(row.value, LIMITS.STATUS_VALUE),
        icon: row.icon,
        color: row.color,
      }),
    )
    // The core drops an item missing a required field; drop it here so the row
    // count we check below is the row count the user sees.
    .filter((item) => item.label !== undefined && item.value !== undefined)
    .slice(0, LIMITS.STATUS_ITEMS);

  return items.length === 0 ? null : { type: 'status', items };
}

/**
 * The focal list: rows (`list`) or a poster grid (`grid`). Tapping an item that
 * carries a description or links opens the core's detail panel.
 * @param {{ display?: 'list'|'grid', items: Array<object> }} options
 */
export function cardList({ display = 'list', items }) {
  const max = display === 'grid' ? LIMITS.CARD_ITEMS_GRID : LIMITS.CARD_ITEMS_LIST;
  const bounded = items
    .map((item) =>
      compact({
        title: boundedText(item.title, LIMITS.CARD_TITLE),
        subtitle: boundedText(item.subtitle, LIMITS.CARD_SUBTITLE),
        // Dates stay ISO: the core formats them in the user's locale and
        // timezone, which is the one rule we must NOT second-guess here.
        date: item.date,
        badge: item.badge
          ? compact({
              text: boundedText(item.badge.text, LIMITS.CARD_BADGE),
              color: item.badge.color,
            })
          : undefined,
        description: boundedText(item.description, LIMITS.CARD_DESCRIPTION),
        links: item.links
          ? item.links
              .filter((link) => typeof link?.url === 'string' && link.url.startsWith('https://'))
              .slice(0, LIMITS.CARD_LINKS)
              .map((link) =>
                compact({ url: link.url, label: boundedText(link.label, LIMITS.LINK_LABEL) }),
              )
          : undefined,
      }),
    )
    .filter((item) => item.title !== undefined)
    .slice(0, max);

  return bounded.length === 0 ? null : { type: 'card-list', display, items: bounded };
}

/**
 * A button. Exactly one of `action` (calls us back), `deviceFeature` + `value`
 * (sends a value on one of our features) or `link` (opens a URL).
 * @param {{ label: unknown, style?: 'primary'|'secondary'|'danger', icon?: string,
 *   action?: { key: string, params?: object, confirm?: boolean },
 *   deviceFeature?: string, value?: number, link?: { url: string, label?: unknown } }} options
 */
export function button({ label, style = 'secondary', icon, action, deviceFeature, value, link }) {
  const bounded = boundedText(label, LIMITS.BUTTON_LABEL);
  const kinds = [action, deviceFeature, link].filter((kind) => kind !== undefined && kind !== null);
  if (bounded === undefined || kinds.length !== 1) {
    return null;
  }
  if (link && !String(link.url).startsWith('https://')) {
    // `http` links are refused by the core: a button that would never work is
    // better absent than present and dead.
    return null;
  }
  return compact({
    type: 'button',
    label: bounded,
    style,
    icon,
    action,
    device_feature: deviceFeature,
    value: deviceFeature ? value : undefined,
    link,
  });
}

/**
 * Assemble the final payload, applying the content budget.
 *
 * Components are given in the order that matters to us; the core then renders
 * them in its own canonical order (header text, tiles, focal, status, buttons),
 * so this order only decides WHO SURVIVES when a cap is reached — first come,
 * first served, exactly like the core.
 *
 * @param {Array<object|null>} components `null` entries (a builder that had
 *   nothing to show) are dropped
 * @param {{ ttlSeconds?: number }} [options] how long the core may cache this
 *   content before pulling again
 */
export function buildContent(components, { ttlSeconds = 300 } = {}) {
  const counters = { focal: 0, tiles: 0, texts: 0, bodyTexts: 0, status: 0, buttons: 0 };
  const kept = [];

  for (const component of components) {
    if (!component) {
      continue;
    }
    if (kept.length >= BUDGET.COMPONENTS) {
      logger.warn(`Widget content over budget: "${component.type}" dropped (8 components max)`);
      continue;
    }
    const { type } = component;
    if (type === 'text') {
      const isBody = (component.variant ?? 'body') === 'body';
      if (counters.texts >= BUDGET.TEXTS || (isBody && counters.bodyTexts >= BUDGET.BODY_TEXTS)) {
        logger.warn('Widget content over budget: text dropped');
        continue;
      }
      counters.texts += 1;
      counters.bodyTexts += isBody ? 1 : 0;
    } else if (TILE_TYPES.has(type)) {
      if (counters.tiles >= BUDGET.TILES) {
        logger.warn('Widget content over budget: tile dropped (6 tiles max)');
        continue;
      }
      counters.tiles += 1;
    } else if (type === 'button') {
      if (counters.buttons >= BUDGET.BUTTONS) {
        logger.warn('Widget content over budget: button dropped (4 buttons max)');
        continue;
      }
      counters.buttons += 1;
    }
    if (FOCAL_TYPES.has(type)) {
      if (
        counters.focal >= BUDGET.FOCAL ||
        (type === 'status' && counters.status >= BUDGET.STATUS)
      ) {
        logger.warn(`Widget content over budget: "${type}" dropped (one focal component per card)`);
        continue;
      }
      counters.focal += 1;
      counters.status += type === 'status' ? 1 : 0;
    }
    kept.push(component);
  }

  return {
    version: CONTENT_VERSION,
    ttl_seconds: Math.min(LIMITS.TTL_MAX, Math.max(LIMITS.TTL_MIN, Math.round(ttlSeconds))),
    components: kept,
  };
}

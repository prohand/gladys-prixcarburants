// -----------------------------------------------------------------------------
// Widget: "Cheapest around me"
//
// The question this integration exists to answer, on the dashboard instead of
// in a device list: where do I fill up today, is it a good day to do it, and
// how much will it cost?
//
// The card, slot by slot (the core imposes the order, we choose the content):
//   heading   SP95 · within 10 km of 35000        — the fuel AND the area, because
//                                                   a price without its area means nothing
//   tiles     cheapest / average / 7-day trend    — the three numbers of a decision
//   caption   prices read on 19/09/2026 at 10:30  — how old what you read is
//   chart     the last 30 days of the cheapest price
//   status    the ranked stations, their price and the day it was declared
//   buttons   the official national map
//
// The curve and the trend come from `src/priceHistory.js`: the open data feed
// publishes the prices of the moment, so the integration samples the cheapest
// price of the area itself, at most once an hour. The curve is drawn from the
// very first pull — a single point on day one — and fills itself afterwards,
// including while nobody watches the dashboard (src/refresh.js samples too).
// The trend tile keeps its place from day one and shows a dash until the
// history really covers its window, because "0 ct over 7 days" on day one would
// be a measurement nobody made.
// -----------------------------------------------------------------------------

import { isConfigReady } from '../config.js';
import { resolveSearchCenter } from '../house.js';
import { FUELS, FUEL_KEYS, fuelLabel } from '../fuels.js';
import { getProvider } from '../countries/index.js';
import { formatInstant } from '../text.js';
import { COLOR, buildContent, button, chart, statusList, text, valueTile } from './content.js';
import { PRICE_UNIT, buildRowLabels, formatPrice, formatShortDate } from './format.js';

export const KEY = 'best_prices';

/** How long the core may serve this card from its cache (seconds). */
const TTL_SECONDS = 600;

/** Scopes offered in the settings: search around the postal code, or my stations. */
const SCOPE = { AROUND: 'around', TRACKED: 'tracked' };

/** Rankings the user can pick, as strings — a `select` value is a string. */
const COUNTS = ['3', '5', '8'];
const DEFAULT_COUNT = '5';

/** The window the trend tile compares over. */
const TREND_DAYS = 7;

/**
 * Two points at the very same instant are one point, and one point is what
 * makes the axis spread into the future. A second apart is enough to keep two.
 */
const LIVE_POINT_MIN_GAP_MS = 1000;

/**
 * Manifest declaration. Mirrored in `gladys-assistant-integration.json` and
 * checked both ways by test/manifest.test.js — this object is the source.
 */
export const DECLARATION = {
  key: KEY,
  label: { en: 'Cheapest around me', fr: 'Les moins chers' },
  description: {
    en: 'The cheapest stations for one fuel, with the trend of the last 30 days.',
    fr: 'Les stations les moins chères pour un carburant, avec la tendance sur 30 jours.',
  },
  icon: 'trending-down',
  settings: [
    {
      key: 'fuel',
      type: 'select',
      label: { en: 'Fuel', fr: 'Carburant' },
      description: {
        en: 'The fuel this card ranks the stations for.',
        fr: 'Le carburant pour lequel cette carte classe les stations.',
      },
      default: 'gazole',
      options: FUEL_KEYS.map((key) => ({ value: key, label: FUELS[key].label })),
    },
    {
      key: 'scope',
      type: 'select',
      label: { en: 'Stations', fr: 'Stations' },
      description: {
        en: 'Search around the configured postal code, or rank only the stations you added.',
        fr: 'Chercher autour du code postal configuré, ou classer seulement les stations que vous avez ajoutées.',
      },
      default: SCOPE.AROUND,
      options: [
        {
          value: SCOPE.AROUND,
          label: { en: 'Around my postal code', fr: 'Autour de mon code postal' },
        },
        { value: SCOPE.TRACKED, label: { en: 'My stations only', fr: 'Mes stations seulement' } },
      ],
    },
    {
      key: 'count',
      type: 'select',
      label: { en: 'Stations shown', fr: 'Stations affichées' },
      default: DEFAULT_COUNT,
      options: COUNTS.map((value) => ({ value, label: { en: value, fr: value } })),
    },
  ],
  action_timeout_seconds: 60,
};

/**
 * Read the settings the core sends, falling back on the declared defaults: the
 * core applies them already, but a box saved before a setting existed reaches
 * us without it.
 * @param {Record<string, unknown>} settings
 * @param {object} config normalized integration configuration
 */
function readSettings(settings = {}, config) {
  const fuel = FUEL_KEYS.includes(settings.fuel)
    ? settings.fuel
    : // Not the catalog's first fuel: the one the USER configured, which is the
      // one they are most likely to want ranked.
      (config.fuel_type[0] ?? 'gazole');
  const scope = settings.scope === SCOPE.TRACKED ? SCOPE.TRACKED : SCOPE.AROUND;
  const count = Number(COUNTS.includes(String(settings.count)) ? settings.count : DEFAULT_COUNT);
  return { fuel, scope, count };
}

/**
 * The stations this card ranks, freshest state first.
 * @param {{ config: object, store: object, history?: object }} context
 * @param {string} scope
 */
async function collectStations({ config, store, history }, scope) {
  if (scope === SCOPE.TRACKED) {
    const tracked = store.trackedStations;
    // `getStation` shares one batched request per country, so N stations cost
    // one call whatever N is.
    const stations = await Promise.all(
      tracked.map(({ country, stationId }) => store.getStation(country, stationId)),
    );
    const found = stations.filter(Boolean);
    history?.record(config, found, { scope });
    return found;
  }

  const stations = await store.search(config);
  // Sampling costs nothing here: the stations are already in hand, and the
  // history keeps at most one point an hour whatever the pull rate.
  history?.record(config, stations, { scope });
  return stations;
}

/**
 * The heading: the fuel, and where these prices come from.
 *
 * Saying the area out loud matters more than it looks — the distances of this
 * integration are measured from the POSTAL CODE, not from the house Gladys
 * knows (an integration has no access to it), so the card names its own
 * reference point rather than letting the reader assume another one.
 */
function buildHeading({ config, scope, label, source }) {
  if (scope === SCOPE.TRACKED) {
    return { en: `${label.en} · my stations`, fr: `${label.fr} · mes stations` };
  }
  // "autour de ma maison" but "autour DU 35000": the French article belongs to
  // the reference point, not to the sentence around it.
  const from =
    source === 'house'
      ? { en: 'my home', fr: 'de ma maison' }
      : { en: config.postal_code, fr: `du ${config.postal_code}` };
  if (config.search_radius_km > 0) {
    return {
      en: `${label.en} · within ${config.search_radius_km} km of ${from.en}`,
      fr: `${label.fr} · ${config.search_radius_km} km autour ${from.fr}`,
    };
  }
  return {
    en: `${label.en} · postal code ${config.postal_code}`,
    fr: `${label.fr} · code postal ${config.postal_code}`,
  };
}

/**
 * Build the card.
 * @param {object} _gladys SDK instance (unused: this card reads no device)
 * @param {{ config: object, store: object, history?: object }} context
 * @param {{ settings?: object, language?: string }} request
 */
export async function getContent(_gladys, context, { settings, language = 'en' } = {}) {
  const { config, store, history, house } = context;
  const { fuel, scope, count } = readSettings(settings, config);

  if (!isConfigReady(config)) {
    return buildContent(
      [
        text({
          text: {
            en: 'Set a postal code in the integration configuration to see the stations around you.',
            fr: 'Renseignez un code postal dans la configuration de l’intégration pour voir les stations proches.',
          },
        }),
      ],
      { ttlSeconds: TTL_SECONDS },
    );
  }

  const stations = (await collectStations(context, scope))
    .filter((station) => Number.isFinite(station.prices?.[fuel]))
    .sort((a, b) => a.prices[fuel] - b.prices[fuel]);

  // Every text carries both languages and the core picks the reader's own:
  // `language` only decides the separators of the numbers we format ourselves.
  const label = { en: fuelLabel(fuel, 'en'), fr: fuelLabel(fuel, 'fr') };

  if (stations.length === 0) {
    return buildContent(
      [
        text({
          text:
            scope === SCOPE.TRACKED
              ? {
                  en: `None of your stations publishes a ${label.en} price.`,
                  fr: `Aucune de vos stations ne publie de prix ${label.fr}.`,
                }
              : {
                  en: `No ${label.en} price found around ${config.postal_code}. Try a wider search radius.`,
                  fr: `Aucun prix ${label.fr} trouvé autour de ${config.postal_code}. Essayez un rayon de recherche plus large.`,
                },
        }),
      ],
      { ttlSeconds: TTL_SECONDS },
    );
  }

  const prices = stations.map((station) => station.prices[fuel]);
  const cheapest = prices[0];
  const average = prices.reduce((sum, price) => sum + price, 0) / prices.length;
  const readAt = formatInstant(store.lastFetchAt);
  const mapUrl = getProvider(config.country).mapUrl;
  // Resolved AFTER the search, which has already warmed the house cache.
  const { source } = await resolveSearchCenter(config, house);
  const curve = buildChart(history, { config, fuel, label, scope, cheapest: prices[0] });
  // The labels are built for the ranking as a WHOLE: what a row has to show is
  // whatever tells it from the other rows, which no row can know on its own.
  const ranked = stations.slice(0, count);
  const rowLabels = buildRowLabels(ranked.map((station) => station.name));

  return buildContent(
    [
      text({ variant: 'heading', text: buildHeading({ config, scope, label, source }) }),
      valueTile({
        label: { en: 'Cheapest', fr: 'Moins cher' },
        value: cheapest,
        unit: PRICE_UNIT,
        icon: 'trending-down',
        color: COLOR.SUCCESS,
      }),
      valueTile({
        label: { en: 'Average', fr: 'Moyenne' },
        // Rounded to the pump's own precision: an average of prices ending in
        // .699 is not more precise than the prices it averages.
        value: Number(average.toFixed(3)),
        unit: PRICE_UNIT,
        icon: 'bar-chart-2',
      }),
      buildTrendTile(history, { config, fuel, scope }),
      // The read time, kept in plain sight: a price is only as good as the
      // moment it was read, and this is the one date every card shares.
      readAt
        ? text({
            variant: 'caption',
            text: { en: `Prices read on ${readAt}`, fr: `Prix relevés le ${readAt}` },
          })
        : null,
      curve,
      statusList(
        ranked.map((station, index) => ({
          // Shortened on our side, and shortened against EACH OTHER: the label
          // and the value share the width of the row, so a long name is what
          // cuts the price and its date on a phone, and a name cut at the brand
          // makes five stations of the same chain five identical rows — see
          // `buildRowLabels`.
          label: rowLabels[index],
          // The price AND the day the station declared it: the caption above
          // says when WE read the feed, this says how old the price itself is —
          // a station that has not moved its prices in a week is normal, and
          // only this date says so. Short (`auj.`, `22/09`) because the row is
          // one line and a phone cuts it: see `formatShortDate`.
          //
          // No `€/L` here, unlike the tiles: the unit is the same on all five
          // rows and is already printed twice above, and those four characters
          // are exactly what the date needs to survive the line.
          value: `${formatPrice(station.prices[fuel], language)}${declaredAt(station, fuel, language)}`,
          icon: 'map-pin',
          // The cheapest one is the answer to the question; the others are the
          // context that makes it an answer.
          color: index === 0 ? COLOR.SUCCESS : COLOR.NEUTRAL,
        })),
      ),
      mapUrl
        ? button({
            label: { en: 'See the map', fr: 'Voir la carte' },
            icon: 'map',
            link: { url: mapUrl },
          })
        : null,
      // Only while there is no curve: with one, the eight components of the
      // budget are spent and the card is better off keeping the map than a
      // button the core makes redundant by re-pulling on its own.
      curve
        ? null
        : button({
            label: { en: 'Refresh', fr: 'Rafraîchir' },
            icon: 'refresh-cw',
            action: { key: 'refresh' },
          }),
    ],
    { ttlSeconds: TTL_SECONDS },
  );
}

/**
 * The trend tile: how much the cheapest price moved over the last week, in
 * CENTIMES, which is the unit a driver actually feels (a price moves by 2 cts,
 * not by 0.021 EUR).
 *
 * Absent — not zeroed — while the history is younger than the window: a card
 * that claims "0 over 7 days" on its first day is a card that lies.
 */
function buildTrendTile(history, { config, fuel, scope }) {
  const trend = history?.trend(config, fuel, TREND_DAYS, scope);
  if (trend === null || trend === undefined) {
    // A dash, never a zero: the tile keeps its place next to the average from
    // day one, and says plainly that a week of history does not exist yet
    // rather than claiming the price did not move.
    return valueTile({
      label: { en: `Over ${TREND_DAYS} days`, fr: `Sur ${TREND_DAYS} jours` },
      value: '—',
      color: COLOR.NEUTRAL,
    });
  }
  const cents = Number((trend * 100).toFixed(1));
  return valueTile({
    label: { en: `Over ${TREND_DAYS} days`, fr: `Sur ${TREND_DAYS} jours` },
    value: cents,
    unit: 'ct',
    icon: cents > 0 ? 'trending-up' : 'trending-down',
    // Cheaper than last week is good news, and the colour says it before the
    // number is read.
    color: cents > 0 ? COLOR.DANGER : cents < 0 ? COLOR.SUCCESS : COLOR.NEUTRAL,
  });
}

/**
 * ` · auj.`, ` · hier`, ` · 19/09` — the DAY the station declared this price, or
 * an empty string when the feed does not say. Appended to the price rather than
 * given its own row: a status item holds one label and one value, and the label
 * is the station's name. Kept short so the whole row survives a phone screen;
 * the full timestamp stays on the device page and on the "My station" card.
 */
function declaredAt(station, fuel, language) {
  const declared = formatShortDate(station.updatedAt?.[fuel], language);
  return declared ? ` · ${declared}` : '';
}

/**
 * The 30-day curve of the cheapest price.
 *
 * Drawn from the FIRST pull: a card that shows its curve empty on day one and
 * fills it day after day is honest about what it is doing, where a card that
 * hides it looks broken.
 *
 * It ALWAYS ends on the price this very pull just read. That is not padding —
 * it is the freshest measurement the card has — and it is what keeps the axis
 * honest: a chart drawn from a single point makes ApexCharts spread its axis
 * around it and print dates in the FUTURE, which is exactly what a price curve
 * must never show. With a point at "now" the right edge is now, and the window
 * grows towards thirty days as the samples pile up behind it.
 */
function buildChart(history, { config, fuel, label, scope, cheapest }) {
  const recorded = history?.dailySeries(config, fuel, scope) ?? [];
  const points = [...recorded];
  const now = Date.now();
  const last = points[points.length - 1];

  // Always end on the price this very pull just read: that is the freshest
  // measurement the card has, and it pins the right edge of the axis to NOW.
  if (!last || now - new Date(last.t).getTime() > LIVE_POINT_MIN_GAP_MS) {
    points.push({ t: new Date(now).toISOString(), v: cheapest });
  }

  // One point is not a curve, and ApexCharts draws it by spreading the axis
  // around it — which is how a price chart ends up printing NEXT WEEK under a
  // single spike. On the very first pull, the day the card is added, anchor the
  // line at the start of that day: the value is the one we measured, the anchor
  // only gives the axis a width. From the second sample on (one an hour), the
  // real points take over and this never runs again.
  if (points.length === 1) {
    const anchor = new Date(points[0].t);
    anchor.setHours(0, 0, 0, 0);
    points.unshift({ t: anchor.toISOString(), v: points[0].v });
  }

  return chart({
    chartType: 'area',
    title: { en: 'Last 30 days', fr: '30 derniers jours' },
    unit: PRICE_UNIT,
    series: [{ name: label, points }],
  });
}

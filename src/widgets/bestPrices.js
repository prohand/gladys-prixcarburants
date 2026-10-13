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
import { inEveryLanguage } from '../i18n.js';
import { formatInstant, startOfZonedDay } from '../text.js';
import { COLOR, buildContent, button, chart, statusList, text, valueTile } from './content.js';
import {
  PRICE_UNIT,
  ROW_LABEL_LENGTHS,
  ROW_LABEL_MAX,
  buildRowLabels,
  formatPrice,
  formatShortDate,
} from './format.js';

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
  label: {
    en: 'Cheapest around me',
    fr: 'Les moins chers',
    de: 'Am günstigsten in der Nähe',
    es: 'Lo más barato cerca',
  },
  description: {
    en: 'The cheapest stations for one fuel, with the trend of the last 30 days.',
    fr: 'Les stations les moins chères pour un carburant, avec la tendance sur 30 jours.',
    de: 'Die günstigsten Tankstellen für einen Kraftstoff, mit dem Trend der letzten 30 Tage.',
    es: 'Las gasolineras más baratas para un carburante, con la tendencia de los últimos 30 días.',
  },
  icon: 'trending-down',
  settings: [
    {
      key: 'fuel',
      type: 'select',
      label: { en: 'Fuel', fr: 'Carburant', de: 'Kraftstoff', es: 'Carburante' },
      description: {
        en: 'The fuel this card ranks the stations for.',
        fr: 'Le carburant pour lequel cette carte classe les stations.',
        de: 'Der Kraftstoff, für den diese Karte die Tankstellen sortiert.',
        es: 'El carburante para el que esta tarjeta clasifica las gasolineras.',
      },
      default: 'gazole',
      options: FUEL_KEYS.map((key) => ({ value: key, label: FUELS[key].label })),
    },
    {
      key: 'scope',
      type: 'select',
      label: { en: 'Stations', fr: 'Stations', de: 'Tankstellen', es: 'Gasolineras' },
      description: {
        en: 'Search around you (the house or the postal code, as set in the configuration), or rank only the stations you added.',
        fr: 'Chercher autour de vous (la maison ou le code postal, selon la configuration), ou classer seulement les stations que vous avez ajoutées.',
        de: 'In Ihrer Umgebung suchen (Zuhause oder Postleitzahl, je nach Konfiguration) oder nur die von Ihnen hinzugefügten Tankstellen sortieren.',
        es: 'Buscar a su alrededor (la vivienda o el código postal, según la configuración) o clasificar solo las gasolineras que ha añadido.',
      },
      default: SCOPE.AROUND,
      options: [
        {
          value: SCOPE.AROUND,
          // Neither "around my postal code" (the search is centred on the
          // house whenever the configuration says so, and that label sent a
          // user with several houses looking for a bug in the wrong place) nor
          // "around me" (read as the PHONE's position, which nothing asks for).
          label: {
            en: 'Around the house or postal code',
            fr: 'Autour de la maison ou du code postal',
            de: 'Um das Zuhause oder die Postleitzahl',
            es: 'Cerca de la vivienda o del código postal',
          },
        },
        {
          value: SCOPE.TRACKED,
          label: {
            en: 'My stations only',
            fr: 'Mes stations seulement',
            de: 'Nur meine Tankstellen',
            es: 'Solo mis gasolineras',
          },
        },
      ],
    },
    {
      key: 'count',
      type: 'select',
      label: {
        en: 'Stations shown',
        fr: 'Stations affichées',
        de: 'Angezeigte Tankstellen',
        es: 'Gasolineras mostradas',
      },
      default: DEFAULT_COUNT,
      options: COUNTS.map((value) => ({ value, label: inEveryLanguage(() => value) })),
    },
    {
      // The core sends no screen width with a pull, so the integration cannot
      // fit the names to the screen by itself: the user picks the width their
      // screens hold. 24 is what a phone shows next to the price and its date.
      key: 'name_length',
      type: 'select',
      label: {
        en: 'Station name length',
        fr: 'Longueur des noms',
        de: 'Länge der Namen',
        es: 'Longitud de los nombres',
      },
      description: {
        en: 'Characters a station name may use. Longer is easier to read on a wide screen; on a narrow one, the date of the price may get cut.',
        fr: 'Nombre de caractères pour le nom d’une station. Plus long se lit mieux sur un grand écran ; sur un petit écran, la date du prix risque d’être coupée.',
        de: 'Anzahl der Zeichen für den Namen einer Tankstelle. Länger liest sich auf einem breiten Bildschirm besser; auf einem schmalen kann das Datum des Preises abgeschnitten werden.',
        es: 'Número de caracteres para el nombre de una gasolinera. Más largo se lee mejor en una pantalla ancha; en una estrecha, la fecha del precio puede quedar cortada.',
      },
      default: String(ROW_LABEL_MAX),
      options: ROW_LABEL_LENGTHS.map((value) => ({
        value,
        label:
          value === String(ROW_LABEL_MAX)
            ? {
                en: `${value} characters (phone)`,
                fr: `${value} caractères (téléphone)`,
                de: `${value} Zeichen (Smartphone)`,
                es: `${value} caracteres (móvil)`,
              }
            : {
                en: `${value} characters`,
                fr: `${value} caractères`,
                de: `${value} Zeichen`,
                es: `${value} caracteres`,
              },
      })),
    },
    {
      // A user with a house in Noisy and one in Brittany wanted one card per
      // house; the configuration centres every card on ONE of them. Gladys 5.2
      // lists the houses itself (`source: "houses"`, the selector is stored),
      // so a card can name its own. Empty = the centre of the configuration.
      key: 'house',
      type: 'select',
      source: 'houses',
      label: { en: 'House', fr: 'Maison', de: 'Zuhause', es: 'Vivienda' },
      description: {
        en: 'Rank the stations around this house instead of the one of the configuration (it needs coordinates in Gladys).',
        fr: 'Classer les stations autour de cette maison plutôt que celle de la configuration (elle doit avoir des coordonnées dans Gladys).',
        de: 'Die Tankstellen um dieses Zuhause statt um das der Konfiguration sortieren (es braucht Koordinaten in Gladys).',
        es: 'Clasificar las gasolineras alrededor de esta vivienda en lugar de la de la configuración (necesita coordenadas en Gladys).',
      },
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
  const nameLength = ROW_LABEL_LENGTHS.includes(String(settings.name_length))
    ? Number(settings.name_length)
    : ROW_LABEL_MAX;
  return { fuel, scope, count, nameLength };
}

/**
 * The configuration as THIS card sees it: a card naming its own house searches
 * around that house, whatever the configuration says. Everything downstream
 * keys on the result — the station search, the curve, the heading — so two
 * cards on two houses never share a ranking nor a curve.
 * @param {object} config normalized integration configuration
 * @param {Record<string, unknown>} settings
 */
function cardConfig(config, settings = {}) {
  const house = typeof settings.house === 'string' ? settings.house.trim() : '';
  return house ? { ...config, search_center: 'house', house } : config;
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
function buildHeading({ config, scope, label, source, houseName }) {
  if (scope === SCOPE.TRACKED) {
    return {
      en: `${label.en} · my stations`,
      fr: `${label.fr} · mes stations`,
      de: `${label.de} · meine Tankstellen`,
      es: `${label.es} · mis gasolineras`,
    };
  }
  // "autour de ma maison" but "autour DU 35000": the French article belongs to
  // the reference point, not to the sentence around it.
  // With several houses, "my home" says nothing: the card names the one it
  // measures from, so a holiday house picked by default shows on the card.
  const from =
    source !== 'house'
      ? {
          en: config.postal_code,
          fr: `du ${config.postal_code}`,
          de: config.postal_code,
          es: config.postal_code,
        }
      : houseName
        ? { en: houseName, fr: `de ${houseName}`, de: houseName, es: houseName }
        : { en: 'my home', fr: 'de ma maison', de: 'mein Zuhause', es: 'mi casa' };
  if (config.search_radius_km > 0) {
    return {
      en: `${label.en} · within ${config.search_radius_km} km of ${from.en}`,
      fr: `${label.fr} · ${config.search_radius_km} km autour ${from.fr}`,
      de: `${label.de} · ${config.search_radius_km} km um ${from.de}`,
      es: `${label.es} · a ${config.search_radius_km} km de ${from.es}`,
    };
  }
  return {
    en: `${label.en} · postal code ${config.postal_code}`,
    fr: `${label.fr} · code postal ${config.postal_code}`,
    de: `${label.de} · Postleitzahl ${config.postal_code}`,
    es: `${label.es} · código postal ${config.postal_code}`,
  };
}

/**
 * Build the card.
 * @param {object} _gladys SDK instance (unused: this card reads no device)
 * @param {{ config: object, store: object, history?: object }} context
 * @param {{ settings?: object, language?: string }} request
 */
export async function getContent(_gladys, context, { settings, language = 'en' } = {}) {
  const { store, history, house } = context;
  const config = cardConfig(context.config, settings);
  const { fuel, scope, count, nameLength } = readSettings(settings, config);

  if (!isConfigReady(config)) {
    return buildContent(
      [
        text({
          text: {
            en: 'Set a postal code in the integration configuration to see the stations around you.',
            fr: 'Renseignez un code postal dans la configuration de l’intégration pour voir les stations proches.',
            de: 'Geben Sie in der Konfiguration der Integration eine Postleitzahl ein, um die Tankstellen in Ihrer Nähe zu sehen.',
            es: 'Introduzca un código postal en la configuración de la integración para ver las gasolineras cercanas.',
          },
        }),
      ],
      { ttlSeconds: TTL_SECONDS },
    );
  }

  const stations = (await collectStations({ store, history, config }, scope))
    .filter((station) => Number.isFinite(station.prices?.[fuel]))
    .sort((a, b) => a.prices[fuel] - b.prices[fuel]);

  // Every text carries every language and the core picks the reader's own:
  // `language` only decides the separators of the numbers we format ourselves.
  const label = inEveryLanguage((lang) => fuelLabel(fuel, lang));

  if (stations.length === 0) {
    return buildContent(
      [
        text({
          text:
            scope === SCOPE.TRACKED
              ? {
                  en: `None of your stations publishes a ${label.en} price.`,
                  fr: `Aucune de vos stations ne publie de prix ${label.fr}.`,
                  de: `Keine Ihrer Tankstellen veröffentlicht einen Preis für ${label.de}.`,
                  es: `Ninguna de sus gasolineras publica un precio de ${label.es}.`,
                }
              : {
                  en: `No ${label.en} price found around ${config.postal_code}. Try a wider search radius.`,
                  fr: `Aucun prix ${label.fr} trouvé autour de ${config.postal_code}. Essayez un rayon de recherche plus large.`,
                  de: `Kein Preis für ${label.de} um ${config.postal_code} gefunden. Versuchen Sie einen größeren Suchradius.`,
                  es: `No se ha encontrado ningún precio de ${label.es} alrededor de ${config.postal_code}. Pruebe con un radio de búsqueda mayor.`,
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
  const { source, houseName } = await resolveSearchCenter(config, house);
  const curve = buildChart(history, { config, fuel, label, scope, cheapest: prices[0] });
  // The labels are built for the ranking as a WHOLE: what a row has to show is
  // whatever tells it from the other rows, which no row can know on its own.
  const ranked = stations.slice(0, count);
  const rowLabels = buildRowLabels(ranked, nameLength);

  return buildContent(
    [
      text({ variant: 'heading', text: buildHeading({ config, scope, label, source, houseName }) }),
      valueTile({
        label: { en: 'Cheapest', fr: 'Moins cher', de: 'Am günstigsten', es: 'Más barato' },
        // TEXT, not a number: the front formats an inline number with
        // `maximumFractionDigits: 2`, so 1,699 € reached the card as "1,7" —
        // the third decimal of a pump price is exactly what tells two stations
        // apart. Formatted here, it survives.
        value: formatPrice(cheapest, language),
        unit: PRICE_UNIT,
        icon: 'trending-down',
        color: COLOR.SUCCESS,
      }),
      valueTile({
        label: { en: 'Average', fr: 'Moyenne', de: 'Durchschnitt', es: 'Media' },
        // Same, and rounded to the pump's own precision on the way: an average
        // of prices ending in .699 is not more precise than the prices it
        // averages.
        value: formatPrice(average, language),
        unit: PRICE_UNIT,
        icon: 'bar-chart-2',
      }),
      buildTrendTile(history, { config, fuel, scope }),
      // The read time, kept in plain sight: a price is only as good as the
      // moment it was read, and this is the one date every card shares.
      readAt
        ? text({
            variant: 'caption',
            text: {
              en: `Prices read on ${readAt}`,
              fr: `Prix relevés le ${readAt}`,
              de: `Preise abgefragt am ${readAt}`,
              es: `Precios leídos el ${readAt}`,
            },
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
            label: {
              en: 'See the map',
              fr: 'Voir la carte',
              de: 'Karte anzeigen',
              es: 'Ver el mapa',
            },
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
            label: { en: 'Refresh', fr: 'Rafraîchir', de: 'Aktualisieren', es: 'Actualizar' },
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
      label: {
        en: `Over ${TREND_DAYS} days`,
        fr: `Sur ${TREND_DAYS} jours`,
        de: `Über ${TREND_DAYS} Tage`,
        es: `En ${TREND_DAYS} días`,
      },
      value: '—',
      color: COLOR.NEUTRAL,
    });
  }
  const cents = Number((trend * 100).toFixed(1));
  return valueTile({
    label: {
      en: `Over ${TREND_DAYS} days`,
      fr: `Sur ${TREND_DAYS} jours`,
      de: `Über ${TREND_DAYS} Tage`,
      es: `En ${TREND_DAYS} días`,
    },
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
  // The start of the day on the USER's clock (`displayTimeZone()`), not the
  // container's UTC one, which would open a Paris day at 02:00.
  if (points.length === 1) {
    const anchor = startOfZonedDay(new Date(points[0].t));
    points.unshift({ t: anchor.toISOString(), v: points[0].v });
  }

  return chart({
    chartType: 'area',
    title: {
      en: 'Last 30 days',
      fr: '30 derniers jours',
      de: 'Letzte 30 Tage',
      es: 'Últimos 30 días',
    },
    unit: PRICE_UNIT,
    series: [{ name: label, points }],
  });
}

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Gladys Assistant **external integration** (Node 20+, ESM, no build step) that tracks fuel
prices at petrol stations around a postal code, from national open data. It runs as a
container next to Gladys and talks to it over a WebSocket via
`@gladysassistant/integration-sdk`. There is no HTTP server and no database — everything
lives in memory and Gladys owns the device state.

## Commands

```bash
npm install
npm test                              # node --test (built-in runner, no framework)
node --test test/devices.test.js      # one file
node --test --test-name-pattern="discovery"   # one test by name
npm run lint                          # eslint .
npm run format:check                  # prettier --check .   (CI gate — run before committing)
npm run format                        # prettier --write .

# run against a local Gladys
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="prix-carburants" \
LOG_LEVEL=debug npm start

npx github:GladysAssistant/integration-store .   # same checks as the store indexer
```

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on Node 24 — the same
version as the Docker image. Releases are UI-driven only: **Actions → Release → Run
workflow** bumps `package.json` + manifest `version`/`docker_image`, tags `vX.Y.Z` and calls
`build.yml`. Never bump the version by hand.

Tests never hit the network: they inject fakes through the seams
(`createStationStore({ resolveProvider })`, `createRefreshLoop({ setTimer, clearTimer })`) and
use the helpers in `test/helpers/fakeGladys.js`.

## Architecture

```
config (country, postal code, radius, fuels)
   → country provider   src/countries/<code>.js   stations + prices from open data
   → station store      src/stationStore.js       cache + per-country batched refresh
   → price history      src/priceHistory.js       30-day samples of the cheapest price
   → device registry    src/devices/              one device per (station, fuel)
   → Discovery tab / refresh loop  src/refresh.js
   → dashboard widgets  src/widgets/             two declarative cards
   → scene triggers     src/sceneEvents.js       fired at the end of a pass
   → scene actions      src/sceneActions.js      what a scene can ask us to do
```

`index.js` is pure wiring: it registers every SDK handler _before_ `connect()` and holds no
business logic. On `connected` it re-reads the config, syncs the tracked station set from the
devices Gladys holds, publishes discovery, arms the refresh loop and reports
`setConnectionStatus`.

### Invariants that shape the code

- **One device = one station AND one fuel**, encoded in the external id
  (`ext:<selector>:fuel-station:FR-35000005-gazole`). A Gladys device keeps the features it
  was created with, so the fuel must be part of the id — ticking another fuel later adds
  discovery entries rather than rewriting existing devices. Fuel keys in `src/fuels.js` and
  country codes are therefore **append-only**: renaming one orphans users' devices.
- **Devices already created are always re-published** by `publishDiscovery`, merged after the
  search results so a created device's user-chosen name wins. Moving the postal code must not
  drop a working device.
- **A (station, fuel) pair the station does not sell is never published** — the dataset covers
  every pump in the country, so offering "LPG at a station that sells none" creates devices
  that can never publish a state. "Sells it" is not "has a price today": the feed declares
  RUPTURES, and a temporary one is a pump waiting for a tanker, so `src/availability.js` turns
  an empty price column into `available` / `out_of_stock` / `not_sold` and only the last one
  is dropped. Out of stock is published as a device, previewed as "en rupture" rather than
  "non vendu", and shown on the device's text feature ("En rupture depuis le …") so a frozen
  price says why it is frozen. The feed can also say NOTHING about a fuel (rupture lifted,
  price not typed back yet): `src/countries/franceRecent.js` checks those silent fuels — never
  a definitive rupture — against 30 days of daily history, and a fuel priced in that window is
  out of stock, not "not sold". Best effort and cached 6 h, like the names.
- **Exactly one device is not a station**: `src/devices/integration.js`
  (`ext:<selector>:integration:status`), publishing when the feed was last read _successfully_.
  Its platform id is a constant so changing country or postal code never orphans it, it is
  always appended by `publishDiscovery` even when the search is empty, and `parseTargets`
  ignores it — every station code path must keep ignoring it (route it with
  `isIntegrationDevice` first, as `onPoll`/`onDeviceCreated` do). Distinct from a station's
  `updated_at`, which is the date the STATION declared its price: a stale one there is normal,
  a stale one here means the API stopped answering, so a failed pass must leave it ageing.
- **Dates are displayed as `08/08/2026 à 21:00`**, via `formatDateTime` (feed strings, parsed
  TEXTUALLY so the container timezone cannot shift a declared wall-clock time) and
  `formatInstant` (instants we observed, in container-local time) in `src/text.js`.
- **Devices carry no `poll_frequency`.** Gladys' `poll_frequency` is an enum capped at 60s;
  any other value makes it reject the _entire_ discovery payload (the Discovery tab silently
  stays empty). The 10 min–24 h interval the user configures is honoured by
  `createRefreshLoop` in `src/refresh.js` instead. `onPoll` stays registered anyway.
- **Every feature needs `min` and `max`**, including text ones — they are NOT NULL in Gladys,
  and omitting them fails device creation with `HTTP 422 - min cannot be null`.
- **All station reads go through `stationStore`.** Gladys polls devices one by one; the store
  batches every tracked station of a country into one request and shares the in-flight
  promise, so ten devices cost one HTTP call. Never call a provider directly from a device or
  refresh path.
- **Scene triggers AND actions need Gladys 5.1** (GladysAssistant/Gladys#3110): the manifest
  `scene_triggers`, fired by `src/sceneEvents.js` through the SDK's `publishSceneEvent()`
  at the end of a refresh pass. Trigger keys, filter keys and variable keys are **append-only**
  for the same reason as the fuels: a scene stores them. Two rules the module must keep — one
  event per TRANSITION (never one per pass) and no baseline, no event (the first pass after a
  restart only records, so a restart never replays "everything changed"). A price THRESHOLD
  stays out: a price is a device feature, and `device.new-state` already covers it.
  `scene_actions` (`src/sceneActions.js`) is the other half: the core sends
  `external-integration.scene-action.run` over the WS and reads `data.outputs` back, so the
  handlers return OUTPUT OBJECTS while the manifest `actions` of `src/actions.js` return a
  bilingual message — two namespaces, never one handler for both. An action is never a
  condition: answer `found: false`, never throw, when there is simply nothing to report. Both
  halves sit on SDK members (`publishSceneEvent`, `onSceneAction`, 0.14.0 and up) — the raw
  host-API route and the WS-message interception that stood in for them are gone. A core older
  than 5.1 rejects a manifest carrying `scene_triggers`/`scene_actions` outright, so
  `gladys_version` and these fields move together (the `categories`/4.86 precedent, pinned by
  `test/manifest.test.js`), and the publisher still disables itself on the first 404.
- **A missing price is not an error**: `pollDevice` publishes nothing and keeps the last known
  value rather than drawing a hole in the history chart. Likewise a station absent from the
  feed keeps its stale cache entry.

### Dashboard widgets

`src/widgets/` implements the capability of GladysAssistant/Gladys#3109: the manifest declares
a widget's IDENTITY (`key`, `label`, `icon`, `settings`), the integration produces its CONTENT
at runtime as a tree of components in the core's vocabulary, and Gladys validates, bounds,
caches and renders it. Two cards: `best_prices` (ranking of the cheapest stations for one
fuel) and `station` (one followed station, a price tile per fuel).

- **The core silently trims whatever exceeds a bound**, so `src/widgets/content.js` applies
  the spec's own limits (characters per field, 8 components, 1 focal, 6 tiles, 2 texts,
  1 status, 4 buttons) on our side and `test/widgets.test.js` asserts them — a violation must
  fail a test, not leave a hole in someone's dashboard.
- **`status` is NOT a focal component.** The core's `FOCAL_TYPES` is
  `['chart', 'card-list', 'image']` and `status` has a budget of its own, so a card may carry
  a chart AND the list under it — which is what `best_prices` does.
- **The curve is drawn from the first pull** — because a card that hides its chart until it
  has data looks broken. Two rules keep its axis honest, and both exist because the FRONT lets
  ApexCharts auto-range over the points we send (`interval` only drives the tooltip format, so
  no 30-day window can be imposed): the series always ENDS on the price the pull just read, and
  a series that would hold a single point is anchored at the start of that day — one point
  makes ApexCharts spread the axis and print dates in the FUTURE, which is what a price curve
  must never do. The anchor carries the measured value and only gives the axis a width; from
  the second sample on (one an hour) it never runs. The TREND tile keeps its place next to the
  average from day one and shows an em dash until the history covers its window, since "0 ct
  over 7 days" on day one is a measurement nobody made.
- **The ranking rows carry the date the STATION declared its price**, next to the price, while
  the caption above carries the moment WE read the feed. Two different dates, both wanted:
  a stale one in a row is normal, a stale one in the caption means the API stopped answering.
  In a row that date is SHORT (`formatShortDate`: `auj.` / `hier` / `06/08` / `31/12/25`,
  no hour) — a status row is one line and a phone cuts `1,990 €/L · 22/09/2026 à 09:00`
  mid-date; the full `formatDateTime` stays on the device page and on the `station` card.
  The LABEL and the VALUE of a status row share that line, so shortening the date was not
  enough on its own: a long name squeezes the value until the date goes too. The ranking
  therefore bounds the name to 24 chars and drops the `€/L` the tiles above already carry —
  the row reads `TotalEne. Acc. - Lyon 7e 1,990 · auj.` Any redesign of that row must keep
  label + value inside about forty characters BY DEFAULT, and the widget content is the same
  on every screen (the core sends no viewport), so the integration cannot fit a wide screen
  by itself: the card's `name_length` setting (`ROW_LABEL_LENGTHS`, 24 by default up to the
  core's 40) is how a user trades a phone's safety for a wider screen's room, and every rule
  below is written against that `max`, never against 24. Whatever the width, the characters
  are spent on telling the stations APART.
  Two rules do that, in `src/widgets/format.js`. `shortenStationName` serves the PLACE first
  and makes the brand pay — a name is `brand - city` or `brand - street - city`, the brand is
  the head the core would keep, and it is the one part that names nothing when five stations
  of the same chain are ranked together. The brand is compacted, never dropped (a row naming
  no brand names no station): its words go back to their root where they have one
  (`TotalEnergies` → `Total`, free), then the trailing qualifiers are abbreviated and finally
  dropped (`Total Access` → `Total Acc.` → `Total`) rather than the name of the chain itself
  being reduced to a stump — `brandFloor` keeps that first word whole (up to half the row)
  wherever a width is computed, so a long street pays instead: a Vichy ranking once read
  `Carre.` on three rows because the widest street of the chain set its brand's width. A segment of more than two words is a street, not a brand, so it
  is CUT instead (`141 Boulevard…`, never `141 Boulevard`), and so is any place. A middle
  segment is dropped rather than left as a third stump. `buildRowLabels` then shortens the
  rows AGAINST EACH OTHER, in two passes, and what drives the first one is the PLACE, not a
  clash: a city named by one row is what the reader is looking for
  (`Total - Oullins-Pierre…`), a city named by SEVERAL rows tells them apart from nothing —
  `Lyon` is half a million people and five pumps. So every row sharing its city shows its
  STREET, brand still in front, the brand of a chain compacted to one width across the whole
  ranking so it does not read two ways in two consecutive rows, and a row with no street to
  show is left alone rather than losing its brand for nothing. The city stays BEHIND that
  street whenever the row holds all three (`Total - Garnier, Lyon`), because a street alone
  asks where it is and no other row answers — the city was the only thing carrying it. What
  pays for that room is the street, in the order that costs the reader the least: written
  whole, then without the kind of way it is (`Rue de Gerland` → `Gerland`), then reduced to
  the name a local says (`Av. Tony Garnier` → `Garnier`) — a pump is found by the NAME of its
  street, `Av.` and `Rue de` are what every other street of the city carries too. One form for
  the whole city group, never one per row, and the city is given up again — back to
  `Total - Av. Tony Garnier` — when the shortest street form still does not fit behind it,
  when it would be the city's own name (`Lyon, Lyon`), or when shortening would make two rows
  of the group read the same: telling the rows APART comes first, that is what a ranking is.
  Without the city, the street goes through the same forms, only as far as the brand needs
  to keep its chain name (`Carrefour - Peupliers`, not `Carre. - Rue des Peupli…`), and a row
  that holds WHOLE is written `brand - street, city` like the grouped ones. The street comes from the name when it carries one and from
  the station's `address` otherwise — the device name only spells it out when two devices
  would collide, the dashboard needs it as soon as a city is shared — and it is displayed as a
  street is written, not as the feed stores it: the house number is dropped before the name of
  the street is cut (`Rue de Gerland`, never `112/116 Rue de…`, since a map fills the number
  in, and the number goes before the city joins the row), and an ALL-CAPS or all-lowercase word goes back to title case (`AVENUE TONY GARNIER` →
  `Av. Tony Garnier`) while `ZA` and an already-cased name stay untouched. The technical id
  `disambiguateStationNames` appends when even the street is not enough (two pumps of one
  avenue) is dropped from the row — eight digits name nothing to a driver — but only once
  there is a street to show instead. Only what is still written twice afterwards pays the
  second pass, which gives the whole row to the place and loses the brand — the case where the
  CITY is what got truncated (`Saint-Germain-en-Laye` against `Saint-Germain-lès-Corbeil`).
  Best effort: names that stay equal are left equal, never numbered.
  `src/refresh.js` samples too, but only for an area the history already follows
  (`history.knows`), so the curve keeps filling with no dashboard open while an install without
  a widget pays nothing.
- **The 30-day curve and the 7-day trend come from our own samples** (`src/priceHistory.js`):
  no device holds "the cheapest price of the area", and the feed publishes the present only.
  Samples are taken on the searches the widget already runs, at most one an hour, kept 30 days
  in `/data`, keyed by country + postal code + radius + SCOPE + fuel so moving the area (or
  switching the card between "around me" and "my stations") starts a new
  curve. Best effort: an unwritable `/data` costs the curve, never the integration, and the
  trend tile is ABSENT rather than zero while the history is younger than its window — the one
  exception to "no state that must survive a restart", and it is additive by construction.
- **Distances start at the Gladys house when it is located**, at the centre of the postal code
  otherwise, and both cards SAY which (`2,3 km de la maison` / `2,3 km du 35000`,
  `10 km autour de ma maison` / `autour du 35000`) — do not let a redesign drop that word.
  `src/house.js` reads `GET /api/integration/v1/house` with the SDK's own base URL and token
  (the SDK wraps no such call), which requires `"location": true` in the manifest — the two
  ship together, a 403 is the symptom of forgetting one. Cached an hour, invalidated on
  `onConfigUpdated`, and best effort everywhere: `resolveSearchCenter` falls back on the postal
  code for an unlocated house, an older core or a network failure. A Gladys install can hold
  SEVERAL houses, and the route returns them all: the module keeps every located one and
  `config.house_name` names which to measure from, matched loosely (trimmed, case- and
  accent-insensitive), the first one winning when the field is empty or matches nothing (said
  once in the logs, never as an error). That field is free TEXT and not a select on purpose —
  the core resolves dynamic select options against an integration's DEVICES only
  (`SELECT_SOURCES = ['devices']`), so no manifest can offer the houses. What makes it usable
  is `searchStations`: the preview action names the house in use and lists the ones Gladys
  knows, because a name nobody shows is a name the user gets wrong. The NAMES may be printed
  there; the coordinates never are, anywhere. The coordinates are personal
  data: they centre the search and nothing else — never a device param, a state, a log or a
  widget content.
- **A price tile carries TEXT, never a number and never a `device_feature`**: the front
  rounds both. An inline number goes through `formatNumber` (`maximumFractionDigits: 2`) and
  a bound feature through `DeviceFeatureValueText` (`Math.round(v * 10) / 10`), so a pump
  price of 1,699 € reached the dashboard as `1,7` while the device page of the very same
  feature showed 1,699 — reported by a user, and the third decimal is exactly what tells two
  stations apart. `formatPrice` therefore builds the string, in the `language` the core sends
  with every pull, and the tiles of both cards send it. What it costs is the live binding the
  `station` card used to have; `notifyWidgetsChanged` pays for it, nudging the core at the end
  of every pass that moved a price.
- **A widget pull must answer well inside the core's 15 s ack** (`WIDGET_GET_TIMEOUT_MS`): a
  missed ack is not a slow card, it is a DEAD one — the front shows "widget data unavailable",
  drops the content it had and schedules NO retry, so the card stays broken until someone
  reloads the dashboard (the user who hit this uninstalled the integration, which remounted
  the cards). A cold container misses it easily: two cards pulling at once, a search walking
  concentric circles at one request per ring, a postal code to geocode, names from two more
  datasets. So `getWidgetContent` races the pull against a deadline of its own
  (`PULL_DEADLINE_MS`, 9 s) and serves a WARMING card past it — a sentence and a 15 s TTL —
  while the real pull keeps running and fills the store cache for the re-pull that follows.
  A thrown error is NOT swallowed by that: the core turns it into a message the user can act
  on, and only a missed ack is the failure with no explanation. `stationStore.search` shares
  its in-flight promise per search criteria for the same reason the country refresh does:
  two cards pulling side by side must cost one search, not two.
- **Declarations live in the code**: `buildWidgetManifest()` is the source and
  `test/manifest.test.js` asserts the manifest `widgets` array deep-equals it. Change both
  together, like the rest of the manifest.
- **The nudge carries no data**: `notifyWidgetsChanged` only tells the core to re-pull, after
  a refresh pass that actually moved a price.
- **The widgets need Gladys 5.1 and SDK 0.14.0**: `registerWidgets` registers on
  `gladys.onWidgetGet(key, cb)` and `gladys.onWidgetAction(key, cb)`, and the core acks for
  us under its own 15 s deadline. An older core rejects the `widgets` field like any unknown
  one, so `gladys_version` carries `">=5.1.0"` — `test/manifest.test.js` fails if the two ever
  drift apart, which is the same guard `categories` gets.

### Country providers

Price open data is national, so each country is a module in `src/countries/` exporting
`code`, `label`, `postalCodeExample`, `fuels`, `attribution`, optional `mapUrl`
(the national map, linked from the widget), `isValidPostalCode()`,
`searchStations({ postalCode, radiusKm, limit })` and `fetchStationsByIds(ids)`. Register it
in `src/countries/index.js` and add its option to the manifest `country` field — nothing else
changes, since device ids already carry the country code.

France (`france.js`) queries the Opendatasoft `explore/v2.1` API of the _flux instantané v2_
dataset. Two quirks worth knowing: the parsing is deliberately tolerant (flat `gazole_prix`
columns _and_ nested `prix` arrays, flat `sp98_rupture_type` columns _and_ a nested `rupture`
array whose entries pile up over the years — only the most recent one per fuel describes the
station today, and an unqualified `type` means temporary — degrees _and_ hundred-thousandths
of a degree, prices in euros _and_ in thousandths), and the price feed **does not publish
station names** — brands
come from separate reference datasets via `franceNames.js`, best effort, cached for the life
of the container, falling back to an address-based name. ODSQL `where` clauses are built by
string concatenation, so every id goes through the sanitizers before interpolation, and id
batches are capped at 25 terms.

Two things shape the search itself, and both come from the API answering `within_distance` in
DATASET order (by id, hence by postal code) rather than by distance. First, a truncated circle
drops the highest postal codes, not the farthest stations — so `searchAround` queries concentric
circles from 5 km, doubling up to the configured radius, and stops on the first COMPLETE circle
holding at least `limit` stations, which is then guaranteed to hold the nearest ones. Second,
the circle needs a centre: the average position of the stations of the postal code when it has
any, and otherwise `franceGeocode.js`, which asks the Base Adresse Nationale where the postal
code is — without it, a postal code with no station of its own returned nothing at any radius.
Best effort like the names: no centre means the stations of the postal code only, never an error.

### The manifest is part of the contract

`gladys-assistant-integration.json` declares the config schema and the action buttons.
`test/manifest.test.js` fails whenever it drifts from the code: action keys must match
`ACTIONS` in `src/actions.js` both ways, defaults must equal `DEFAULT_CONFIG`, the country and
fuel selects must list exactly what the code implements, and numeric bounds must match the
clamps in `normalizeConfig`. Change both sides together.

Action handlers return a `{ en, fr }` object displayed under the button (a thrown error is
displayed too), so every user-facing string in `src/actions.js` is bilingual. User docs live
in `docs/en.md` and `docs/fr.md` and are re-hosted by Gladys — keep them in sync with
behaviour changes.

### Runtime constraints

The Gladys sandbox mounts the rootfs **read-only** with `/data` as the only writable volume,
and the container runs as a non-root user. Do not write files outside `/data`, and do not
introduce state the integration NEEDS to survive a restart — the store rebuilds itself from
the devices Gladys holds on every `connected`. `src/priceHistory.js` is the only file written,
and it is additive: everything works without it, it only makes the widget curve survive a
restart.

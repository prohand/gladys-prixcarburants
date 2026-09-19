# Prix carburants — Gladys Assistant integration

External integration for [Gladys Assistant](https://gladysassistant.com) that
follows **fuel prices at the petrol stations around a postal code**, from
official open data. Built on the JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
from the [official template](https://github.com/GladysAssistant/integration-template-js).

The user fills in a country, a postal code and the fuel(s) they use; the
stations around show up in the **Discovery** tab with their current price, and
they add the ones they want to follow. Each added station becomes a device
with a price history. Deleting the device stops the tracking.

No account, no API key: everything comes from public open data.

| Country   | Data source                                                                                                                                                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🇫🇷 France | [prix-carburants.gouv.fr open data](https://www.prix-carburants.gouv.fr/rubrique/opendata/), queried through the [`flux instantané v2` dataset](https://data.economie.gouv.fr/explore/dataset/prix-des-carburants-en-france-flux-instantane-v2/) (Etalab licence) |

## How it works

```
Configuration (country, postal code, radius, fuels)
        │
        ▼
  country provider ──────────► stations + prices        src/countries/<country>.js
        │
        ▼
   station store  ──────────► cache + batched refresh   src/stationStore.js
        │
        ▼
  device registry ──────────► one device per (station, fuel)
        │                                                src/devices/
        ▼
     Discovery tab ──► the user adds / deletes stations
        │
        ▼
  dashboard widgets ──► two declarative cards               src/widgets/
```

Three decisions worth knowing before reading the code:

- **One device = one station AND one fuel.** A Gladys device keeps the
  features it was created with, so the fuel is part of the device external id
  (`FR-35000005-gazole`). Ticking an extra fuel later adds new discovery
  entries instead of silently rewriting the devices already on a dashboard.
- **Only real combinations are published.** A (station, fuel) pair without a
  price is skipped: the dataset covers every pump in the country, and offering
  "LPG at a station that does not sell LPG" would fill the Discovery tab with
  devices that can never publish a state.
- **Devices already created are always re-published.** Moving the postal code
  must not drop a device that keeps working, so discovery publishes the search
  results _merged with_ the stations the user already added.
- **The dashboard widgets describe, they do not draw.** A widget declares a
  tree of components (tiles, a list, a status, buttons) in Gladys' own
  vocabulary; the core validates it, bounds it, caches it and renders it. See
  [Dashboard widgets](#dashboard-widgets).

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no business logic)
├─ src/
│  ├─ config.js                      # config defaults, type coercion, clamping
│  ├─ fuels.js                       # fuel catalog (stable keys + labels)
│  ├─ geo.js                         # haversine distance / centroid
│  ├─ stationStore.js                # cache + per-country batched refresh
│  ├─ priceHistory.js                # 30-day samples of the cheapest price (/data)
│  ├─ house.js                       # house coordinates (GET /house) + search centre
│  ├─ actions.js                     # the Configuration screen buttons
│  ├─ widgets/
│  │  ├─ index.js                    #   widget registry + SDK wiring
│  │  ├─ sdkBridge.js                #   answers widget messages the SDK ignores
│  │  ├─ content.js                  #   the content vocabulary, bounds, budget
│  │  ├─ bestPrices.js               #   card "Cheapest around me"
│  │  ├─ station.js                  #   card "My station"
│  │  └─ format.js                   #   price / distance / directions helpers
│  ├─ countries/
│  │  ├─ index.js                    #   country registry (+ how to add one)
│  │  └─ france.js                   #   France provider (open data API)
│  └─ devices/
│     ├─ index.js                    #   discovery: search -> devices -> publish
│     └─ fuelStation.js              #   the station device type (features, poll)
├─ docs/en.md, docs/fr.md            # user documentation, re-hosted by Gladys
├─ gladys-assistant-integration.json # manifest (config schema, actions, image)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ .github/workflows/                # CI + UI-driven release + multi-arch build
```

## Adding a country

Fuel price open data is national, so the integration keeps one provider per
country behind a common interface:

1. create `src/countries/<country>.js` exporting `code`, `label`,
   `postalCodeExample`, `fuels`, `attribution`, `isValidPostalCode()`,
   `searchStations({ postalCode, radiusKm, limit })` and
   `fetchStationsByIds(ids)` — see [`france.js`](./src/countries/france.js) for
   a worked example;
2. register it in [`src/countries/index.js`](./src/countries/index.js);
3. add its option to the `country` field of the manifest `config_schema`.

Nothing else changes: device ids already carry the country code, so stations
from two countries coexist, and `test/manifest.test.js` fails until the
manifest lists exactly the countries the code implements.

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="prix-carburants" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs inside its sandboxed container; the SDK reads them
automatically.

## Quality checks

The same three checks run on every push and pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

```bash
npm run format:check   # Prettier: is everything formatted?
npm run lint           # ESLint: catch real mistakes
npm test               # Unit tests, via the built-in `node --test` runner
```

Tests cover the parts worth pinning down: the tolerance of the open data
parsing (`test/france.test.js`), the request batching that protects the public
API from the one-poll-per-device pattern (`test/stationStore.test.js`), the
discovery/merge rules (`test/devices.test.js`) and the manifest ↔ code
consistency (`test/manifest.test.js`). They use fakes, never the network.

## Catalog categories

The manifest declares `"categories": ["energy"]` — the shelf of the store
catalog this integration sits on (without it, the integration would only show
under "All" and in the search). One to three keys are allowed, among `climate`,
`lighting`, `energy`, `security`, `multimedia`, `appliances`, `environment`,
`protocols`, `network`, `notifications`, `assistants`, `services`. The field
only exists since Gladys 4.86, and an older core rejects a manifest carrying
unknown fields: `categories` and `"gladys_version": ">=4.86.0"` therefore move
together, which `test/manifest.test.js` checks.

## Dashboard widgets

The integration declares two cards in the manifest `widgets` field, filled in
at runtime by `src/widgets/`:

| Key           | Card                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `best_prices` | **Cheapest around me** — cheapest and average price as tiles, then the ranked stations with their distance, price and declared date |
| `station`     | **My station** — one station you follow: a price tile per fuel, its address and the date of its last price update                   |

Three things shape the code:

- **We describe, the core renders.** No HTML, no CSS, no colour: components,
  semantic colours and Feather icon names only. `src/widgets/content.js`
  applies the spec's own character bounds and content budget (8 components, one
  focal, 6 tiles, 4 buttons) so a card is never trimmed behind our back.
- **A tracked fuel is a LIVE tile.** When the station/fuel pair has a device,
  the tile is declared as a `device_feature` reference instead of a value: the
  dashboard then follows the feature over the WebSocket and the price moves the
  moment the refresh loop publishes it, with no widget pull at all.
- **One pull path, one nudge.** The cards are built from the same station
  store as the devices, and a refresh pass that moved a price only sends
  `requestWidgetRefresh` — a "re-pull me" carrying no data.
- **The curve is sampled, not fetched.** The feed publishes the prices of the
  moment, so `src/priceHistory.js` records the cheapest price of the area at
  most once an hour (on the searches the widget already does) and keeps 30 days
  in `/data`. Best effort by design: an unwritable volume costs the curve and
  nothing else, and the trend tile is absent rather than zero while the history
  is younger than its window.
- **Distances start at the Gladys house when it is located.** The manifest
  declares `"location": true` and `src/house.js` reads
  `GET /api/integration/v1/house` (Gladys ≥ 4.85, 403 without the declaration),
  cached an hour and best effort: no house, no coordinates, an older core — the
  search falls back on the centre of the postal code. Either way the cards say
  which (`2.3 km from home` / `2.3 km from 35000`), and the coordinates never
  reach a device, a state, a log or a widget content.

> **Not releasable yet.** The `widgets` manifest field and the SDK handlers
> come from [GladysAssistant/Gladys#3109](https://github.com/GladysAssistant/Gladys/pull/3109),
> which is still open. Until it ships:
>
> - `npx github:GladysAssistant/integration-store .` fails with
>   `manifest: must NOT have additional properties` — the published schema does
>   not know `widgets` yet;
> - `@gladysassistant/integration-sdk` (0.13.0, latest) has no `onWidgetGet`
>   and its dispatcher ignores unknown message types silently, so
>   `src/widgets/sdkBridge.js` answers `widget.get` / `widget.action` on the
>   SDK's own socket. `registerWidgets()` switches to `gladys.onWidgetGet` the
>   day the SDK ships it, and the bridge can then be deleted.
>
> When the PR lands: bump `gladys_version` to the first release accepting
> `widgets`, raise the SDK dependency, re-run the store validator, and release.

## Validate before publishing

```bash
npx github:GladysAssistant/integration-store .
```

Runs the exact same checks as the store indexer (manifest, Docker image, cover
image, code rules) and reports every problem at once.

## Publish

1. Add the GitHub topic `gladys-assistant-integration` to the repository.
2. **Actions → Release → Run workflow**, pick `patch`, `minor` or `major`. The
   workflow bumps the version everywhere (`package.json` + manifest
   `version`/`docker_image`), pushes the `vX.Y.Z` tag and builds the
   `linux/amd64` + `linux/arm64` image to `ghcr.io`.
3. The decentralized indexer picks up the new manifest version and Gladys
   offers a one-click install.

> Replace `cover.png` (800×534 px, ≤150 KB) before publishing if you want
> something other than the bundled one.

## Licence

Apache-2.0. Fuel price data stays under its own licence — Etalab open licence
for France; the attribution is carried by each country provider.

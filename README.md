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

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no business logic)
├─ src/
│  ├─ config.js                      # config defaults, type coercion, clamping
│  ├─ fuels.js                       # fuel catalog (stable keys + labels)
│  ├─ geo.js                         # haversine distance / centroid
│  ├─ stationStore.js                # cache + per-country batched refresh
│  ├─ sceneEvents.js                 # scene triggers fired at the end of a pass
│  ├─ actions.js                     # the Configuration screen buttons
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

## Local / Cloud tag

The manifest declares `"transports": ["cloud"]`. The catalog reads that field
to draw the **Local** / **Cloud** tag on the integration card and to answer the
matching facet of the store: without it the card carries no tag at all
([issue 10](https://github.com/prohand/gladys-prixcarburants/issues/10)). Every price here comes from a national open data
API over the internet, so `cloud` is the whole truth — declaring `local` as
well would add the core's "Prefer local (LAN) connection" toggle to a
configuration screen where it would mean nothing. `test/manifest.test.js`
pins it.

## Scene triggers (preview — NOT releasable yet)

The manifest declares three `scene_triggers`, fired by `src/sceneEvents.js` at
the end of every refresh pass:

| Key                        | Fired when                                                         |
| -------------------------- | ------------------------------------------------------------------ |
| `price_updated`            | a followed station moved a price (carries the old one and the gap) |
| `cheapest_station_changed` | another followed station is now the cheapest for a fuel            |
| `feed_status_changed`      | every station of a pass failed, or the feed answers again          |

They rest on **[GladysAssistant/Gladys#3110](https://github.com/GladysAssistant/Gladys/pull/3110),
which is not released**: `scene_triggers` in the manifest and
`POST /api/integration/v1/scene/event` to fire one. Consequences, today:

- a **released** Gladys rejects a manifest carrying unknown fields, and
  `npx github:GladysAssistant/integration-store .` answers
  `manifest: must NOT have additional properties`. This branch is therefore
  testable against a Gladys built from the PR, and **must not be released as
  is**;
- before releasing, `gladys_version` has to be raised to the first Gladys
  version that ships the feature — exactly what was done for `categories` and
  4.86.0 — and the store indexer re-run;
- the runtime side is already harmless either way: the first `404` from the
  core disables the publisher for the life of the container, and a refresh pass
  never fails because a scene event could not be delivered.

The SDK does not expose `publishSceneEvent()` yet either, so `sceneEvents.js`
calls it when it exists and falls back to the raw host API route meanwhile.

Two rules the module is built around, both from the spec: **one event per
transition** (a price that did not move fires nothing, whatever the interval)
and **no baseline, no event** (the first pass after a restart only records, so
restarting the container never replays "everything changed"). A price
_threshold_ is deliberately absent: a price is a device feature, and
"below 1.70 €" is already a core `device.new-state` trigger.

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

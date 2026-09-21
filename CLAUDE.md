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
   → device registry    src/devices/              one device per (station, fuel)
   → Discovery tab / refresh loop  src/refresh.js
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
  price says why it is frozen.
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
- **A missing price is not an error**: `pollDevice` publishes nothing and keeps the last known
  value rather than drawing a hole in the history chart. Likewise a station absent from the
  feed keeps its stale cache entry.

### Country providers

Price open data is national, so each country is a module in `src/countries/` exporting
`code`, `label`, `postalCodeExample`, `fuels`, `attribution`, `isValidPostalCode()`,
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
introduce state that needs to survive a restart — the store rebuilds itself from the devices
Gladys holds on every `connected`.

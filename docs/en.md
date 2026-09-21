# Fuel prices

Follow the price of the fuel you use at the petrol stations near you, right
inside Gladys: one device per station, a price history, and scenes that can
warn you when filling up becomes worth it.

Data comes from **official open data**. No account, no API key, no
subscription.

| Country | Source                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------- |
| France  | [prix-carburants.gouv.fr](https://www.prix-carburants.gouv.fr/rubrique/opendata/) (Etalab licence) |

More countries can be added in future versions: the integration is built
around one "provider" per country.

## What you get

For **every station you add**, a device with two read-only features:

- **Price** — the price per litre of the chosen fuel, in euros. History is
  kept, so Gladys charts the price over time.
- **Last price update** — when the station declared that price, shown as
  `06/08/2026 à 07:12` in the station's own local time. The national feed
  refreshes about every 10 minutes, but a given station does not change its
  prices every day: this date tells you how old the price above really is.
  It is read per station **and** per fuel, so the diesel and the SP98 of the
  same station each carry their own date.

The address, the brand, the GPS coordinates and the distance to the postal
code are stored in the device parameters.

### The "Prix carburants - Mise à jour des données" device

Besides the stations, the Discovery tab offers **one single device, shared by
the whole integration**, with one feature:

- **Dernière lecture des données** — the date and time, as
  `08/08/2026 à 21:00`, of the last **successful** read of the open data feed
  by the integration. The device and its feature are named in French, like the
  data source they report on.

This is not the same information as a station's "Last price update": that one
tells you when the station moved its prices (a week ago is perfectly normal),
this one tells you whether the integration can still reach the national API. A
date that starts ageing while your refresh interval is one hour means the data
source stopped answering.

The device is optional: leave it out and the integration behaves exactly the
same. Added, it is updated at the end of every refresh pass, and stays empty
until a first read has succeeded.

A device is named after the brand of the station and its city, e.g.
`Total Access - Oullins-Pierre-Bénite - SP98`. The national price feed does not
publish that brand, so it is read from a reference dataset of the same
information system; a station that reference dataset does not know keeps a name
built from its street.

When two stations of the same brand share a city, their street is added to the
name so you can tell them apart: `TotalEnergies - 33 Av. Médéric -
Noisy-le-Grand - Diesel`. In the rare case where even the street is the same
(both sides of a motorway rest area), the national id of the station is appended.
Devices already created keep the name they were given: rename them in
**Devices**, or delete and re-add them from the **Discovery** tab to get the
detailed name (their price history is lost in the process).

## Configuration

1. Open the **Configuration** tab of the integration.
2. Pick your **country** (France for now).
3. Fill in your **postal code** (5 digits in France, e.g. `35000`). Stations
   are searched around it.
4. Set the **search radius**: `0` keeps only the stations of the postal code
   itself, `10` km widens the search to the neighbouring towns. A postal code
   with no petrol station of its own is fine: the search is centred on your
   town anyway, so the pumps of the next one show up.
5. Tick the **fuel type(s)** you care about: Diesel, SP95, SP98, E10, E85,
   LPG.
6. Save.

The **Preview the nearby stations** button immediately shows what the search
returns, with the current prices — handy to tune the postal code or the radius
before adding anything.

## Adding stations

Open the **Discovery** tab: the stations found appear there, one entry per
station **and** per selected fuel ("TotalEnergies - Rennes - Diesel",
"TotalEnergies - Rennes - SP98"…). Click **Add** on the ones you want to
follow. Add one, several, or all of them.

Only the combinations that really exist are offered: a station that does not
sell LPG never shows up in the LPG list.

Once added, the station publishes its price straight away, then at every
refresh (once an hour by default). The pace is the **Refresh interval** of the
Configuration tab: the integration runs its own timer, so the device shows no
polling option on the Gladys side. The **Refresh the prices now** button forces
a read without waiting.

## Removing stations

Open the device in **Settings → Devices**, then **Delete**. The integration
stops polling it immediately. The station stays visible in the **Discovery**
tab as long as it matches your search, so you can add it back later.

Removing one fuel of a station does not affect the others: "Rennes - Diesel"
and "Rennes - SP98" are two independent devices.

## Changing the fuel later

A Gladys device keeps the features it was created with. The fuel is therefore
part of the device identity: ticking an extra fuel in the configuration makes
**new** entries appear in the Discovery tab, and your existing devices keep
working untouched. Delete the ones you no longer need.

## Scene ideas

- Get a notification when the diesel price of your station drops below a
  threshold.
- Compare two stations on the dashboard before driving out to fill up.
- Track the monthly average price thanks to the history.

## Troubleshooting

**No station in the Discovery tab.** Check the postal code (5 digits in
France) and raise the search radius. The **Preview the nearby stations**
button shows the exact error message.

**The price stopped updating.** A station can temporarily disappear from the
national feed (roadworks, closure). The last known price stays displayed;
the integration logs list the missing stations.

**An empty price.** The station is not declaring that fuel right now. The
integration keeps the last known value instead of leaving a hole in the chart.

**The SP95 of a station is missing while its SP98 is there.** That station
does not sell SP95, and it is not a bug: many brands (TotalEnergies in
particular) replaced it with **E10 (SP95-E10)**. Tick E10 in the configuration
and the station comes back in the Discovery tab. The **Preview the nearby
stations** button spells it out station by station: "SP95: not sold".

**Limited number of stations.** The **Maximum number of stations** setting
bounds the discovery list (20 by default, 50 max). In a dense city, lower it
and shrink the radius.

**One particular station is missing.** The list keeps the NEAREST stations, up
to that maximum: in a city, twenty of them fit in a couple of kilometres, so a
station 5 km away is left out even with a 10 km radius. Raise **Maximum number
of stations** rather than the radius. A station that declares no price for the
fuel you ticked is not offered either, since the device would have nothing to
publish.

## Data and licence

The French data is published by the Ministry of the Economy under the
[Etalab open licence](https://www.etalab.gouv.fr/licence-ouverte-open-licence).
The integration queries the
["flux instantané" dataset](https://data.economie.gouv.fr/explore/dataset/prix-des-carburants-en-france-flux-instantane-v2/)
and only fetches the stations around your postal code. When that dataset knows
no station in your postal code, the position of your town is read from the
[Base Adresse Nationale](https://adresse.data.gouv.fr/), the official French
address service — the postal code is the only thing sent to it.

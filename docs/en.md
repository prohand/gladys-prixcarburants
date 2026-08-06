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
- **Last price update** — when the station declared that price (the national
  feed refreshes about every 10 minutes, but a given station does not change
  its prices every day).

The address, the brand, the GPS coordinates and the distance to the postal
code are stored in the device parameters.

A device is named after the brand of the station and its city, e.g.
`Total Access - Oullins-Pierre-Bénite - SP98`. The national price feed does not
publish that brand, so it is read from a reference dataset of the same
information system; a station that reference dataset does not know keeps a name
built from its street.

## Configuration

1. Open the **Configuration** tab of the integration.
2. Pick your **country** (France for now).
3. Fill in your **postal code** (5 digits in France, e.g. `35000`). Stations
   are searched around it.
4. Set the **search radius**: `0` keeps only the stations of the postal code
   itself, `10` km widens the search to the neighbouring towns.
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

**Limited number of stations.** The **Maximum number of stations** setting
bounds the discovery list (20 by default, 50 max). In a dense city, lower it
and shrink the radius.

## Data and licence

The French data is published by the Ministry of the Economy under the
[Etalab open licence](https://www.etalab.gouv.fr/licence-ouverte-open-licence).
The integration queries the
["flux instantané" dataset](https://data.economie.gouv.fr/explore/dataset/prix-des-carburants-en-france-flux-instantane-v2/)
and only fetches the stations around your postal code.

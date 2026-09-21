// -----------------------------------------------------------------------------
// Fuel availability: WHY a (station, fuel) pair has no price today.
//
// The national feed publishes one price column per fuel, and an empty column
// used to be read as a single thing: "this station does not sell that fuel".
// It actually covers two very different situations, and the feed itself tells
// them apart with its `rupture` (out of stock) declarations:
//
//   - rupture TEMPORAIRE : the pump exists, the tank is empty. The station
//     sells that fuel, its price simply comes back in a few hours or days;
//   - rupture DEFINITIVE, or no declaration at all : the station stopped
//     selling that fuel, or never did.
//
// Showing "non vendu" for the first case is what users report as a bug: their
// station DOES sell SP98, it is just out of stock. Hence this three-state
// vocabulary, produced by the country providers and read by the discovery, the
// device poll and the "Search stations" button.
// -----------------------------------------------------------------------------

/** @type {{ AVAILABLE: 'available', OUT_OF_STOCK: 'out_of_stock', NOT_SOLD: 'not_sold' }} */
export const AVAILABILITY = {
  AVAILABLE: 'available',
  OUT_OF_STOCK: 'out_of_stock',
  NOT_SOLD: 'not_sold',
};

/**
 * What the feed says about one fuel of one station.
 *
 * A published price always wins: whatever rupture the feed still carries, a
 * station announcing a price sells that fuel right now. Anything the provider
 * did not qualify falls back to "not sold", which is the historical behaviour.
 *
 * @param {object} station station in the internal shape
 * @param {string} fuel fuel key
 * @returns {'available'|'out_of_stock'|'not_sold'}
 */
export function fuelAvailability(station, fuel) {
  const price = station?.prices?.[fuel];
  if (price !== null && price !== undefined) {
    return AVAILABILITY.AVAILABLE;
  }
  return station?.availability?.[fuel] === AVAILABILITY.OUT_OF_STOCK
    ? AVAILABILITY.OUT_OF_STOCK
    : AVAILABILITY.NOT_SOLD;
}

/**
 * Is that fuel temporarily out of stock — a price we are waiting for, not a
 * pump the station does not have?
 * @param {object} station
 * @param {string} fuel
 */
export function isOutOfStock(station, fuel) {
  return fuelAvailability(station, fuel) === AVAILABILITY.OUT_OF_STOCK;
}

/**
 * Does the station sell that fuel at all — price published or out of stock?
 * This is what decides whether a device is worth offering in the Discovery tab.
 * @param {object} station
 * @param {string} fuel
 */
export function sellsFuel(station, fuel) {
  return fuelAvailability(station, fuel) !== AVAILABILITY.NOT_SOLD;
}

/**
 * Since when that fuel has been out of stock, as the feed published it (a raw
 * timestamp, formatted by the caller). `null` when unknown or irrelevant.
 * @param {object} station
 * @param {string} fuel
 * @returns {string|null}
 */
export function outOfStockSince(station, fuel) {
  return isOutOfStock(station, fuel) ? (station?.outOfStockSince?.[fuel] ?? null) : null;
}

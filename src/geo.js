// -----------------------------------------------------------------------------
// Small geographic helpers shared by the country providers.
// No dependency: a couple of formulas is all we need to sort stations by
// distance and to draw a search circle around a postal code.
// -----------------------------------------------------------------------------

const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance between two points, in kilometres.
 * @param {{ latitude: number, longitude: number }} a
 * @param {{ latitude: number, longitude: number }} b
 * @returns {number|null} null when either point has no usable coordinates
 */
export function distanceKm(a, b) {
  if (!isValidPoint(a) || !isValidPoint(b)) {
    return null;
  }
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * @param {unknown} point
 * @returns {point is { latitude: number, longitude: number }}
 */
export function isValidPoint(point) {
  return (
    !!point &&
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.latitude) <= 90 &&
    Math.abs(point.longitude) <= 180 &&
    // (0, 0) is in the Gulf of Guinea: in this dataset it always means
    // "coordinates missing", never a real petrol station.
    !(point.latitude === 0 && point.longitude === 0)
  );
}

/**
 * Average position of a set of points, used as the centre of the search circle
 * when we only know a postal code.
 * @param {Array<{ latitude: number, longitude: number }>} points
 * @returns {{ latitude: number, longitude: number }|null}
 */
export function centroid(points) {
  const valid = points.filter(isValidPoint);
  if (valid.length === 0) {
    return null;
  }
  const sum = valid.reduce(
    (acc, p) => ({ latitude: acc.latitude + p.latitude, longitude: acc.longitude + p.longitude }),
    { latitude: 0, longitude: 0 },
  );
  return {
    latitude: sum.latitude / valid.length,
    longitude: sum.longitude / valid.length,
  };
}

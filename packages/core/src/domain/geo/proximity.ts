import type { GeoPoint } from "../../contracts/destination";

/**
 * The visitor's position, computed on their device only (ADR-021). Nothing here sends or
 * stores a position: the portal uses these rules in the browser.
 */

/** Mean Earth radius (IUGG), in meters. */
const EARTH_RADIUS = 6_371_008.8;

/** Straight-line ("as the crow flies") distance in meters (haversine). */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Rough travel times from the straight-line distance. Roads are never straight, so the
 * distance is stretched by a detour factor; the portal labels the result as an estimate
 * and opens the device's maps app for a real route.
 */
export const TRAVEL_ESTIMATE = {
  detourFactor: 1.3,
  walkingKmPerHour: 4.5,
  drivingKmPerHour: 30,
  /** Walking times are not shown beyond this distance (meters). */
  maxWalkingDistance: 15_000,
  /** No times at all beyond this distance (the visitor is somewhere else). */
  maxDistance: 300_000,
} as const;

export interface TravelEstimate {
  readonly walkMinutes: number | null;
  readonly driveMinutes: number | null;
}

export function estimateTravel(meters: number): TravelEstimate {
  if (!Number.isFinite(meters) || meters < 0 || meters > TRAVEL_ESTIMATE.maxDistance) {
    return { walkMinutes: null, driveMinutes: null };
  }
  const road = meters * TRAVEL_ESTIMATE.detourFactor;
  const minutes = (kmPerHour: number) => (road / 1000 / kmPerHour) * 60;
  return {
    walkMinutes:
      meters <= TRAVEL_ESTIMATE.maxWalkingDistance
        ? minutes(TRAVEL_ESTIMATE.walkingKmPerHour)
        : null,
    driveMinutes: minutes(TRAVEL_ESTIMATE.drivingKmPerHour),
  };
}

/** Thousands with a dot, decimals with a comma (Spanish, as in Bolivia). */
function spanishNumber(value: number, decimals = 0): string {
  const [whole = "0", fraction] = value.toFixed(decimals).split(".");
  const grouped = whole.length > 3 ? whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ".") : whole;
  return fraction && !/^0+$/u.test(fraction) ? `${grouped},${fraction}` : grouped;
}

/** "menos de 10 m", "350 m", "1,2 km", "12 km", "1.250 km". */
export function formatDistance(meters: number): string {
  if (meters < 10) return "menos de 10 m";
  if (meters < 995) return `${spanishNumber(Math.round(meters / 10) * 10)} m`;
  const km = meters / 1000;
  return km < 9.95 ? `${spanishNumber(km, 1)} km` : `${spanishNumber(Math.round(km))} km`;
}

/** "menos de 1 min", "12 min", "1 h", "2 h 05 min" → "2 h 5 min". */
export function formatMinutes(minutes: number): string {
  if (minutes < 1) return "menos de 1 min";
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export interface ProximityText {
  /** "A 350 m en línea recta" */
  readonly distance: string;
  /** "~5 min a pie · ~1 min en auto (estimado)", or null when too far for estimates. */
  readonly travel: string | null;
}

export function describeProximity(meters: number): ProximityText {
  const { walkMinutes, driveMinutes } = estimateTravel(meters);
  const parts = [
    walkMinutes === null ? null : `~${formatMinutes(walkMinutes)} a pie`,
    driveMinutes === null ? null : `~${formatMinutes(driveMinutes)} en auto`,
  ].filter((part): part is string => part !== null);
  return {
    distance: `A ${formatDistance(meters)} en línea recta`,
    travel: parts.length === 0 ? null : `${parts.join(" · ")} (estimado)`,
  };
}

/** Closest first; items without a point keep their order after the others. */
export function sortByDistance<T>(
  items: readonly T[],
  origin: GeoPoint,
  pointOf: (item: T) => GeoPoint | null,
): T[] {
  return items
    .map((item, index) => {
      const point = pointOf(item);
      return { item, index, meters: point ? distanceMeters(origin, point) : Infinity };
    })
    .sort((a, b) => a.meters - b.meters || a.index - b.index)
    .map((entry) => entry.item);
}

/** One reading of the device's position. */
export interface PositionFix extends GeoPoint {
  /** Radius of the 95 % confidence circle, in meters (as reported by the device). */
  readonly accuracy: number;
  /** Milliseconds since the epoch. */
  readonly at: number;
}

/**
 * Whether a new reading is worth re-rendering for: the device reports positions several
 * times per second while walking, and distances only change meaningfully every few meters.
 */
export function isMeaningfulFix(previous: PositionFix | null, next: PositionFix): boolean {
  if (previous === null) return true;
  if (distanceMeters(previous, next) >= 10) return true;
  const accuracyChange = Math.abs(previous.accuracy - next.accuracy);
  if (accuracyChange >= 20 && accuracyChange >= previous.accuracy * 0.3) return true;
  return next.at - previous.at >= 15_000;
}

/** «Estás cerca de…»: radius around a destination, configurable per municipality. */
export const NEARBY_RADIUS = { default: 150, min: 50, max: 1000 } as const;

export interface NearbyTarget {
  readonly key: string;
  readonly point: GeoPoint;
}

export interface NearbyUpdate {
  /** Targets the visitor is within (after this reading). */
  readonly inside: ReadonlySet<string>;
  /** Targets entered with this reading, closest first (the ones to announce). */
  readonly entered: readonly string[];
}

/**
 * Enter at the radius, leave only beyond radius + margin, so standing at the edge does not
 * announce the same place over and over. A reading less precise than the radius (or
 * 100 m) cannot tell inside from outside: it changes nothing.
 */
export function updateNearby(
  inside: ReadonlySet<string>,
  fix: PositionFix,
  targets: readonly NearbyTarget[],
  radius: number = NEARBY_RADIUS.default,
): NearbyUpdate {
  if (fix.accuracy > Math.max(radius, 100)) return { inside, entered: [] };
  const leaveAt = radius + Math.max(50, radius / 2);
  const next = new Set<string>();
  const entered: { key: string; meters: number }[] = [];
  for (const target of targets) {
    const meters = distanceMeters(fix, target.point);
    const wasInside = inside.has(target.key);
    if (meters <= radius || (wasInside && meters <= leaveAt)) {
      next.add(target.key);
      if (!wasInside) entered.push({ key: target.key, meters });
    }
  }
  entered.sort((a, b) => a.meters - b.meters);
  return { inside: next, entered: entered.map((entry) => entry.key) };
}

/** A circle of `meters` around a point as a closed [lng, lat] ring (GeoJSON order). */
export function circleRing(center: GeoPoint, meters: number, steps = 64): [number, number][] {
  const angular = meters / EARTH_RADIUS;
  const rad = Math.PI / 180;
  const lat1 = center.lat * rad;
  const lng1 = center.lng * rad;
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const bearing = ((i % steps) / steps) * 2 * Math.PI;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
    );
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
        Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
      );
    ring.push([lng2 / rad, lat2 / rad]);
  }
  return ring;
}

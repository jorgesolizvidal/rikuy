import type { GeoPoint } from "../../contracts/destination";
import { distanceMeters } from "./proximity";

/**
 * «Cerca de aquí» on a destination's or an event's page (C3 · Paso 4, ADR-063): the published
 * places closest to this one, in a straight line. The distance is between two published
 * points (never the visitor's position), so the server computes it and the page is cached.
 */

export const NEARBY_PLACES = {
  /** How many places the section shows. */
  limit: 3,
  /** Farther than this is not «cerca», even in a large municipality. */
  maxMeters: 15_000,
} as const;

export interface NearbyPlace<T> {
  readonly place: T;
  /** Straight-line meters from the page's place. */
  readonly meters: number;
}

/**
 * The places closest to `origin`, nearest first, without those that have no location or are
 * too far. Ties keep the input's order. The caller leaves the page's own place out.
 */
export function nearestPlaces<T>(
  origin: GeoPoint,
  places: readonly T[],
  pointOf: (place: T) => GeoPoint | null,
  options: { readonly limit?: number; readonly maxMeters?: number } = {},
): NearbyPlace<T>[] {
  const limit = options.limit ?? NEARBY_PLACES.limit;
  const maxMeters = options.maxMeters ?? NEARBY_PLACES.maxMeters;
  return places
    .flatMap((place, index) => {
      const point = pointOf(place);
      if (point === null) return [];
      const meters = distanceMeters(origin, point);
      return meters <= maxMeters ? [{ place, meters, index }] : [];
    })
    .sort((a, b) => a.meters - b.meters || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map(({ place, meters }) => ({ place, meters }));
}

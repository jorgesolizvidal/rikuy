/**
 * Map areas as [west, south, east, north] in degrees (WGS 84), the order map libraries
 * and PostGIS envelopes use. The antimeridian is not crossed (no municipality needs it).
 */
export interface BoundingBox {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/** Larger areas are refused: the map asks again when the visitor zooms in. */
export const MAX_AREA_SPAN_DEGREES = 20;

/** "w,s,e,n" (as sent by the portal map) → a valid area, or null. */
export function parseBoundingBox(value: string | null | undefined): BoundingBox | null {
  if (typeof value !== "string" || value.length > 120) return null;
  const parts = value.split(",");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) =>
    /^-?\d{1,3}(\.\d{1,8})?$/u.test(part.trim()) ? Number(part) : NaN,
  );
  const [west, south, east, north] = numbers as [number, number, number, number];
  if (numbers.some((n) => !Number.isFinite(n))) return null;
  if (south < -90 || north > 90 || west < -180 || east > 180) return null;
  if (south > north || west > east) return null;
  if (north - south > MAX_AREA_SPAN_DEGREES || east - west > MAX_AREA_SPAN_DEGREES) return null;
  return { west, south, east, north };
}

/**
 * Rounds an area outwards to a grid (default 0.01° ≈ 1 km) so nearby map views share
 * one cache entry, and the area always contains the requested one.
 */
export function snapBoundingBox(box: BoundingBox, step = 0.01): BoundingBox {
  // The epsilon keeps values already on the grid there (-66.14 / 0.01 = -6613.999…).
  const down = (value: number, min: number) =>
    Math.max(min, Math.floor(value / step + 1e-9) * step);
  const up = (value: number, max: number) => Math.min(max, Math.ceil(value / step - 1e-9) * step);
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return {
    west: round(down(box.west, -180)),
    south: round(down(box.south, -90)),
    east: round(up(box.east, 180)),
    north: round(up(box.north, 90)),
  };
}

export function formatBoundingBox(box: BoundingBox): string {
  return [box.west, box.south, box.east, box.north].join(",");
}

/** A little room around a set of points (and a minimum size for a single point). */
export function padBoundingBox(box: BoundingBox, minSpan = 0.02, ratio = 0.15): BoundingBox {
  const width = Math.max(box.east - box.west, minSpan);
  const height = Math.max(box.north - box.south, minSpan);
  const cx = (box.west + box.east) / 2;
  const cy = (box.south + box.north) / 2;
  const w = (width * (1 + ratio)) / 2;
  const h = (height * (1 + ratio)) / 2;
  return {
    west: Math.max(-180, cx - w),
    south: Math.max(-90, cy - h),
    east: Math.min(180, cx + w),
    north: Math.min(90, cy + h),
  };
}

export function containsPoint(box: BoundingBox, point: { lat: number; lng: number }): boolean {
  return (
    point.lng >= box.west &&
    point.lng <= box.east &&
    point.lat >= box.south &&
    point.lat <= box.north
  );
}

/** Whether `inner` lies entirely inside `outer`. */
export function containsBox(outer: BoundingBox, inner: BoundingBox): boolean {
  return (
    inner.west >= outer.west &&
    inner.east <= outer.east &&
    inner.south >= outer.south &&
    inner.north <= outer.north
  );
}

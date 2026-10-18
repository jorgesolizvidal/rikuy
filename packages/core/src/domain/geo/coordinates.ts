import type { GeoPoint } from "../../contracts/destination";

/**
 * Reads coordinates the way people copy them: "-17.3901, -66.1502" (Google Maps, right
 * click), "-17.3901 -66.1502", "-17.3901; -66.1502", or degrees/minutes/seconds such as
 * 17°23'24.4"S 66°09'00.7"W. Always latitude first. Returns null when unsure.
 */
export function parseCoordinates(text: string): GeoPoint | null {
  // Decimal commas ("-17,39, -66,15") are ambiguous with the separator: dots only.
  const value = text.trim();
  return parseDecimal(value) ?? parseDms(value);
}

function inRange(lat: number, lng: number): GeoPoint | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat: round(lat), lng: round(lng) };
}

/** Six decimals ≈ 11 cm: more precision than any phone offers. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function parseDecimal(value: string): GeoPoint | null {
  const match =
    /^\(?\s*(-?\d{1,3}(?:\.\d+)?)\s*°?\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*°?\s*\)?$/u.exec(
      value.replace(/[−–]/gu, "-"),
    );
  return match ? inRange(Number(match[1]), Number(match[2])) : null;
}

function parseDms(value: string): GeoPoint | null {
  const part = String.raw`(\d{1,3})°\s*(?:(\d{1,2})['′]\s*)?(?:(\d{1,2}(?:\.\d+)?)["″]\s*)?([NSEWO])`;
  const match = new RegExp(`^${part}[,;\\s]+${part}$`, "iu").exec(value.replace(/''/gu, '"'));
  if (!match) return null;
  const toDecimal = (deg?: string, min?: string, sec?: string, hemisphere?: string) => {
    const decimal = Number(deg) + Number(min ?? 0) / 60 + Number(sec ?? 0) / 3600;
    return /[SWO]/iu.test(hemisphere ?? "") ? -decimal : decimal;
  };
  const [, d1, m1, s1, h1, d2, m2, s2, h2] = match;
  if (!/[NS]/iu.test(h1 ?? "") || !/[EWO]/iu.test(h2 ?? "")) return null;
  return inRange(toDecimal(d1, m1, s1, h1), toDecimal(d2, m2, s2, h2));
}

export function formatCoordinates(point: GeoPoint): string {
  return `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
}

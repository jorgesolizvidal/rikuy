import { distanceMeters } from "../geo/proximity";

/**
 * Stamps of the tourist passport (C2 · Paso 2, ADR-057).
 *
 * Every stop has a stamp code printed as a QR at the place. Scanning it gives the visitor's
 * phone a stamp signed by the server; the phone keeps its stamps (no account, nothing stored
 * on the server). One stamp per place counts for every circuit that has the place, and
 * stamps do not expire. The position never leaves the phone: it says only whether it was
 * within the place's radius («con ubicación»); otherwise the stamp is «sin ubicación».
 *
 * Pure and without schemas: the browser uses it through `@rikuy/core/passport-client`.
 */

/** A stamp code and a passport id: 22 characters of base64url (128 random bits). */
const TOKEN = /^[A-Za-z0-9_-]{22}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/u;

export function isStampCode(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

export function isPassportId(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

/** A passport id from 16 random bytes (the browser's `crypto.getRandomValues`). */
export function passportIdFrom(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error("A passport id takes 16 random bytes");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** What the server signs and the phone keeps. */
export interface PassportStamp {
  /** The place (content id): survives a change of address (ADR-047). */
  readonly placeId: string;
  /** For showing the passport; the place's current name is on its page. */
  readonly slug: string;
  readonly title: string;
  /** Seconds since the epoch, the server's clock. */
  readonly at: number;
  /** The phone said it was within the place's radius. */
  readonly located: boolean;
  readonly signature: string;
}

export interface StoredPassport {
  readonly id: string;
  /** By place: one stamp per place. */
  readonly stamps: Readonly<Record<string, PassportStamp>>;
}

/** Where the phone keeps its passport (one per portal: each portal is its own origin). */
export const PASSPORT_STORAGE_KEY = "rikuy:passport";

function stampFrom(value: unknown): PassportStamp | null {
  if (typeof value !== "object" || value === null) return null;
  const stamp = value as Record<string, unknown>;
  if (
    typeof stamp.placeId !== "string" ||
    !UUID.test(stamp.placeId) ||
    typeof stamp.slug !== "string" ||
    typeof stamp.title !== "string" ||
    typeof stamp.at !== "number" ||
    !Number.isSafeInteger(stamp.at) ||
    stamp.at <= 0 ||
    typeof stamp.located !== "boolean" ||
    typeof stamp.signature !== "string" ||
    !SIGNATURE.test(stamp.signature)
  ) {
    return null;
  }
  return {
    placeId: stamp.placeId,
    slug: stamp.slug.slice(0, 80),
    title: stamp.title.slice(0, 200),
    at: stamp.at,
    located: stamp.located,
    signature: stamp.signature,
  };
}

/**
 * The passport kept by this phone, or null when there is none (or it is not readable).
 * A stamp that is not well formed is left out; the others stay.
 */
export function parseStoredPassport(raw: string | null): StoredPassport | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || !isPassportId(record.id)) return null;
  const stamps: Record<string, PassportStamp> = {};
  if (typeof record.stamps === "object" && record.stamps !== null) {
    for (const entry of Object.values(record.stamps)) {
      const stamp = stampFrom(entry);
      if (stamp) stamps[stamp.placeId] = stamp;
    }
  }
  return { id: record.id, stamps };
}

export function serializePassport(passport: StoredPassport): string {
  return JSON.stringify({ v: 1, id: passport.id, stamps: passport.stamps });
}

export type AddStampOutcome =
  /** The place had no stamp. */
  | "new"
  /** It had one «sin ubicación»; this one is «con ubicación». */
  | "upgraded"
  /** It already had one at least as good: the first one stays. */
  | "kept";

/** Adds a stamp just received: the first stamp of a place stays, unless the new one is located. */
export function addStamp(
  passport: StoredPassport,
  stamp: PassportStamp,
): { readonly passport: StoredPassport; readonly outcome: AddStampOutcome } {
  const existing = passport.stamps[stamp.placeId];
  if (existing && (existing.located || !stamp.located)) return { passport, outcome: "kept" };
  return {
    passport: { ...passport, stamps: { ...passport.stamps, [stamp.placeId]: stamp } },
    outcome: existing ? "upgraded" : "new",
  };
}

export interface CircuitProgress {
  readonly collected: number;
  readonly total: number;
  readonly complete: boolean;
}

/** The stops of a circuit (place ids) this phone has stamps for. */
export function circuitProgress(
  stopIds: readonly (string | null)[],
  stamps: Readonly<Record<string, PassportStamp>>,
): CircuitProgress {
  const known = stopIds.filter((id): id is string => id !== null);
  const collected = known.filter((id) => stamps[id] !== undefined).length;
  return {
    collected,
    total: stopIds.length,
    complete: stopIds.length > 0 && collected === stopIds.length,
  };
}

export type StampLocation =
  /** Within the place's radius: the stamp is «con ubicación». */
  | "near"
  /** Farther: «sin ubicación», with the distance. */
  | "far"
  /** The reading is not precise enough to tell: «sin ubicación». */
  | "imprecise";

/**
 * Whether the phone is at the place, with the radius of «Estás cerca de…» (ADR-021). A
 * reading less precise than the radius (or 100 m) cannot tell, like the nearby notice.
 */
export function stampLocation(
  fix: { readonly lat: number; readonly lng: number; readonly accuracy: number },
  place: { readonly lat: number; readonly lng: number },
  radius: number,
): { readonly result: StampLocation; readonly meters: number } {
  const meters = distanceMeters(fix, place);
  if (fix.accuracy > Math.max(radius, 100)) return { result: "imprecise", meters };
  return { result: meters <= radius ? "near" : "far", meters };
}

import { describe, expect, it } from "vitest";

import {
  addStamp,
  circuitProgress,
  isPassportId,
  isStampCode,
  parseStoredPassport,
  passportIdFrom,
  serializePassport,
  stampLocation,
  type PassportStamp,
  type StoredPassport,
} from "./stamps";

const PLAZA = "11111111-1111-4111-8111-111111111111";
const MUSEO = "22222222-2222-4222-8222-222222222222";
const SIGNATURE = "a".repeat(43);

function stamp(placeId: string, located: boolean, at = 1_800_000_000): PassportStamp {
  return { placeId, slug: "plaza", title: "Plaza", at, located, signature: SIGNATURE };
}

const empty: StoredPassport = { id: "AbCdEfGhIjKlMnOpQrSt_-", stamps: {} };

describe("stamp codes and passport ids", () => {
  it("are 22 characters of base64url", () => {
    expect(isStampCode("7qVtpcGPSWzBExzRe9Bp4w")).toBe(true);
    expect(isStampCode("KfFqkEb_PUjuztXRmIFGRQ")).toBe(true);
    expect(isStampCode("short")).toBe(false);
    expect(isStampCode("7qVtpcGPSWzBExzRe9Bp4w=")).toBe(false);
    expect(isStampCode("7qVtpcGPSWzBExzRe9B/4w")).toBe(false);
    expect(isPassportId(42)).toBe(false);
  });

  it("makes a passport id from 16 random bytes", () => {
    const id = passportIdFrom(new Uint8Array(16).fill(255));
    expect(id).toBe("_____________________w");
    expect(isPassportId(id)).toBe(true);
    expect(() => passportIdFrom(new Uint8Array(8))).toThrow();
  });
});

describe("the passport kept by the phone", () => {
  it("goes and comes back", () => {
    const passport = addStamp(empty, stamp(PLAZA, true)).passport;
    expect(parseStoredPassport(serializePassport(passport))).toEqual(passport);
  });

  it("is nothing when there is none or it is not readable", () => {
    expect(parseStoredPassport(null)).toBeNull();
    expect(parseStoredPassport("{")).toBeNull();
    expect(parseStoredPassport(JSON.stringify({ v: 2, id: empty.id, stamps: {} }))).toBeNull();
    expect(parseStoredPassport(JSON.stringify({ v: 1, id: "corto", stamps: {} }))).toBeNull();
  });

  it("leaves out a stamp that is not well formed and keeps the others", () => {
    const raw = JSON.stringify({
      v: 1,
      id: empty.id,
      stamps: {
        [PLAZA]: stamp(PLAZA, true),
        x: { ...stamp(MUSEO, true), signature: "corta" },
        y: { ...stamp("no-es-un-id", true) },
        z: "nada",
      },
    });
    expect(Object.keys(parseStoredPassport(raw)?.stamps ?? {})).toEqual([PLAZA]);
  });
});

describe("adding a stamp", () => {
  it("keeps the first stamp of a place", () => {
    const first = addStamp(empty, stamp(PLAZA, false, 1));
    expect(first.outcome).toBe("new");
    const again = addStamp(first.passport, stamp(PLAZA, false, 2));
    expect(again.outcome).toBe("kept");
    expect(again.passport.stamps[PLAZA]?.at).toBe(1);
  });

  it("replaces one «sin ubicación» with one «con ubicación», never the other way", () => {
    const without = addStamp(empty, stamp(PLAZA, false, 1)).passport;
    const upgraded = addStamp(without, stamp(PLAZA, true, 2));
    expect(upgraded.outcome).toBe("upgraded");
    expect(upgraded.passport.stamps[PLAZA]?.located).toBe(true);
    expect(addStamp(upgraded.passport, stamp(PLAZA, false, 3)).outcome).toBe("kept");
  });
});

describe("a circuit's progress", () => {
  it("counts the stops with a stamp, in any order", () => {
    const passport = addStamp(empty, stamp(MUSEO, false)).passport;
    expect(circuitProgress([PLAZA, MUSEO], passport.stamps)).toEqual({
      collected: 1,
      total: 2,
      complete: false,
    });
    const both = addStamp(passport, stamp(PLAZA, true)).passport;
    expect(circuitProgress([PLAZA, MUSEO], both.stamps).complete).toBe(true);
  });

  it("does not count a stop whose place is unknown", () => {
    const passport = addStamp(empty, stamp(PLAZA, true)).passport;
    expect(circuitProgress([PLAZA, null], passport.stamps)).toEqual({
      collected: 1,
      total: 2,
      complete: false,
    });
  });
});

describe("whether the phone is at the place", () => {
  const place = { lat: -17.580445, lng: -65.907589 };

  it("is near within the radius", () => {
    expect(stampLocation({ ...place, accuracy: 20 }, place, 150).result).toBe("near");
    // ~120 m north.
    expect(
      stampLocation({ lat: -17.579365, lng: -65.907589, accuracy: 20 }, place, 150).result,
    ).toBe("near");
  });

  it("is far beyond it, with the distance", () => {
    const far = stampLocation({ lat: -17.59, lng: -65.907589, accuracy: 10 }, place, 150);
    expect(far.result).toBe("far");
    expect(far.meters).toBeGreaterThan(1000);
  });

  it("cannot tell with a reading less precise than the radius", () => {
    expect(stampLocation({ ...place, accuracy: 500 }, place, 150).result).toBe("imprecise");
    expect(stampLocation({ ...place, accuracy: 90 }, place, 50).result).toBe("near");
  });
});

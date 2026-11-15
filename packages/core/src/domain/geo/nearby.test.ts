import { describe, expect, it } from "vitest";

import { NEARBY_PLACES, nearestPlaces } from "./nearby";

const here = { lat: -17.5, lng: -66.0 };
// ~111 m per 0.001° of latitude.
const at = (meters: number) => ({ lat: -17.5 + meters / 111_195, lng: -66.0 });

describe("nearest places (C3 · Paso 4)", () => {
  const places = [
    { name: "lejos", point: at(9_000) },
    { name: "sin ubicación", point: null },
    { name: "cerca", point: at(400) },
    { name: "fuera", point: at(20_000) },
    { name: "medio", point: at(1_200) },
    { name: "otro medio", point: at(1_200) },
  ];

  it("nearest first, without places with no location or too far, up to the limit", () => {
    const found = nearestPlaces(here, places, (place) => place.point);
    expect(found.map((item) => item.place.name)).toEqual(["cerca", "medio", "otro medio"]);
    expect(found[0]?.meters).toBeCloseTo(400, -1);
    expect(found).toHaveLength(NEARBY_PLACES.limit);
  });

  it("ties keep the input's order; a larger limit reaches the far one, never the one out of range", () => {
    const found = nearestPlaces(here, places, (place) => place.point, { limit: 10 });
    expect(found.map((item) => item.place.name)).toEqual(["cerca", "medio", "otro medio", "lejos"]);
    expect(nearestPlaces(here, places, (place) => place.point, { maxMeters: 500 })).toHaveLength(1);
    expect(nearestPlaces(here, [], (place: { point: null }) => place.point)).toEqual([]);
  });
});

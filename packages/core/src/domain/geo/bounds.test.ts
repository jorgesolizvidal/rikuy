import { describe, expect, it } from "vitest";

import { padBoundingBox, parseBoundingBox, snapBoundingBox } from "./bounds";

describe("map areas", () => {
  it("parses west,south,east,north and refuses anything odd", () => {
    expect(parseBoundingBox("-66.5,-17.6,-66,-17.2")).toEqual({
      west: -66.5,
      south: -17.6,
      east: -66,
      north: -17.2,
    });
    for (const bad of [
      null,
      "",
      "1,2,3",
      "a,b,c,d",
      "-66,-17.2,-66.5,-17.6", // west after east
      "-200,-17,-66,-16",
      "-66,-17,-66,-91",
      "-90,-40,-60,-10", // too large
      "1e2,0,2,1",
    ]) {
      expect(parseBoundingBox(bad)).toBeNull();
    }
  });

  it("snaps outwards so nearby views share a cache entry", () => {
    const snapped = snapBoundingBox({
      west: -66.1534,
      south: -17.3911,
      east: -66.1402,
      north: -17.3801,
    });
    expect(snapped).toEqual({ west: -66.16, south: -17.4, east: -66.14, north: -17.38 });
    expect(
      snapBoundingBox({ west: -179.999, south: -89.999, east: 179.999, north: 89.999 }),
    ).toEqual({
      west: -180,
      south: -90,
      east: 180,
      north: 90,
    });
  });

  it("pads a single point into a small area", () => {
    const box = padBoundingBox({ west: -66.15, south: -17.39, east: -66.15, north: -17.39 });
    expect(box.east - box.west).toBeCloseTo(0.023, 3);
    expect(box.north - box.south).toBeCloseTo(0.023, 3);
  });
});

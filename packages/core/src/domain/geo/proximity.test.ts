import { describe, expect, it } from "vitest";

import { containsBox, containsPoint } from "./bounds";
import {
  circleRing,
  describeProximity,
  distanceMeters,
  estimateTravel,
  formatDistance,
  formatMinutes,
  isMeaningfulFix,
  NEARBY_RADIUS,
  sortByDistance,
  updateNearby,
  type PositionFix,
} from "./proximity";

const PLAZA = { lat: -17.3895, lng: -66.1568 };
/** ~111 m north of the plaza (0.001° of latitude). */
const NORTH_111 = { lat: -17.3885, lng: -66.1568 };

const fix = (point: { lat: number; lng: number }, accuracy = 10, at = 0): PositionFix => ({
  ...point,
  accuracy,
  at,
});

describe("distance", () => {
  it("measures straight lines on the Earth", () => {
    expect(distanceMeters(PLAZA, PLAZA)).toBe(0);
    expect(distanceMeters(PLAZA, NORTH_111)).toBeCloseTo(111.2, 0);
    // La Paz → Santa Cruz de la Sierra, ~550 km as the crow flies
    const km =
      distanceMeters({ lat: -16.4955, lng: -68.1336 }, { lat: -17.7834, lng: -63.1821 }) / 1000;
    expect(km).toBeGreaterThan(540);
    expect(km).toBeLessThan(560);
  });

  it("formats distances and times in Spanish", () => {
    expect(formatDistance(4)).toBe("menos de 10 m");
    expect(formatDistance(83)).toBe("80 m");
    expect(formatDistance(994)).toBe("990 m");
    expect(formatDistance(996)).toBe("1 km");
    expect(formatDistance(1234)).toBe("1,2 km");
    expect(formatDistance(12_400)).toBe("12 km");
    expect(formatDistance(1_250_000)).toBe("1.250 km");
    expect(formatMinutes(0.4)).toBe("menos de 1 min");
    expect(formatMinutes(12.4)).toBe("12 min");
    expect(formatMinutes(60)).toBe("1 h");
    expect(formatMinutes(125)).toBe("2 h 5 min");
  });

  it("estimates travel times and says they are estimates", () => {
    // 1 km straight → 1.3 km of road: ~17 min walking, ~3 min driving
    expect(estimateTravel(1000).walkMinutes).toBeCloseTo(17.3, 1);
    expect(estimateTravel(1000).driveMinutes).toBeCloseTo(2.6, 1);
    expect(estimateTravel(20_000).walkMinutes).toBeNull();
    expect(estimateTravel(400_000)).toEqual({ walkMinutes: null, driveMinutes: null });
    expect(describeProximity(1000)).toEqual({
      distance: "A 1 km en línea recta",
      travel: "~17 min a pie · ~3 min en auto (estimado)",
    });
    expect(describeProximity(500_000)).toEqual({
      distance: "A 500 km en línea recta",
      travel: null,
    });
  });

  it("sorts by distance and keeps places without a point last, in order", () => {
    const items = [
      { id: "far", point: { lat: -17.5, lng: -66.1568 } },
      { id: "none-1", point: null },
      { id: "near", point: NORTH_111 },
      { id: "none-2", point: null },
    ];
    expect(sortByDistance(items, PLAZA, (i) => i.point).map((i) => i.id)).toEqual([
      "near",
      "far",
      "none-1",
      "none-2",
    ]);
  });
});

describe("position readings", () => {
  it("skips readings that would not change anything on screen", () => {
    const first = fix(PLAZA, 15, 0);
    expect(isMeaningfulFix(null, first)).toBe(true);
    expect(isMeaningfulFix(first, fix({ lat: -17.38951, lng: -66.1568 }, 15, 1000))).toBe(false);
    expect(isMeaningfulFix(first, fix({ lat: -17.3894, lng: -66.1568 }, 15, 1000))).toBe(true);
    expect(isMeaningfulFix(first, fix(PLAZA, 60, 1000))).toBe(true);
    expect(isMeaningfulFix(first, fix(PLAZA, 18, 1000))).toBe(false);
    expect(isMeaningfulFix(first, fix(PLAZA, 15, 15_000))).toBe(true);
  });
});

describe("«Estás cerca de…»", () => {
  const targets = [
    { key: "plaza", point: PLAZA },
    { key: "mirador", point: { lat: -17.3901, lng: -66.1502 } },
  ];

  it("announces a place once when the visitor enters its radius", () => {
    const away = updateNearby(new Set(), fix({ lat: -17.3875, lng: -66.1568 }), targets);
    expect(away.entered).toEqual([]);
    const enter = updateNearby(away.inside, fix(NORTH_111), targets);
    expect(enter.entered).toEqual(["plaza"]);
    const stay = updateNearby(enter.inside, fix(PLAZA), targets);
    expect(stay.entered).toEqual([]);
    expect([...stay.inside]).toEqual(["plaza"]);
  });

  it("does not flicker at the edge (leaves only beyond the margin)", () => {
    const inside = new Set(["plaza"]);
    // ~180 m: outside the 150 m radius but within the 75 m margin → still inside
    const edge = updateNearby(inside, fix({ lat: -17.38788, lng: -66.1568 }), targets);
    expect([...edge.inside]).toEqual(["plaza"]);
    const gone = updateNearby(edge.inside, fix({ lat: -17.3865, lng: -66.1568 }), targets);
    expect([...gone.inside]).toEqual([]);
    const back = updateNearby(gone.inside, fix(PLAZA), targets);
    expect(back.entered).toEqual(["plaza"]);
  });

  it("ignores readings too imprecise to tell", () => {
    const vague = updateNearby(new Set(), fix(PLAZA, 400), targets);
    expect(vague.entered).toEqual([]);
    // With a larger radius, a less precise reading is enough.
    expect(updateNearby(new Set(), fix(PLAZA, 400), targets, 500).entered).toEqual(["plaza"]);
  });

  it("orders several places entered at once by distance", () => {
    const between = { lat: -17.3898, lng: -66.153 }; // closer to the mirador
    expect(updateNearby(new Set(), fix(between), targets, NEARBY_RADIUS.max).entered).toEqual([
      "mirador",
      "plaza",
    ]);
  });
});

describe("geometry helpers", () => {
  it("draws an accuracy circle as a closed ring", () => {
    const ring = circleRing(PLAZA, 100, 16);
    expect(ring).toHaveLength(17);
    expect(ring[0]).toEqual(ring[16]);
    for (const [lng, lat] of ring) {
      expect(distanceMeters(PLAZA, { lat, lng })).toBeCloseTo(100, 0);
    }
  });

  it("tells points and areas inside an area", () => {
    const box = { west: -67, south: -18, east: -66, north: -17 };
    expect(containsPoint(box, PLAZA)).toBe(true);
    expect(containsPoint(box, { lat: -16, lng: -66.5 })).toBe(false);
    expect(containsBox(box, { west: -66.5, south: -17.5, east: -66.1, north: -17.2 })).toBe(true);
    expect(containsBox(box, { west: -67.5, south: -17.5, east: -66.1, north: -17.2 })).toBe(false);
  });
});

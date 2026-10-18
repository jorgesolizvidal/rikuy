import { describe, expect, it } from "vitest";

import { formatCoordinates, parseCoordinates } from "./coordinates";

describe("coordinates typed or pasted by people", () => {
  it.each([
    ["-17.3901, -66.1502", -17.3901, -66.1502],
    ["-17.3901 -66.1502", -17.3901, -66.1502],
    ["(-17.3901; -66.1502)", -17.3901, -66.1502],
    ["−17.3901, −66.1502", -17.3901, -66.1502],
    [`17°23'24.4"S 66°09'00.7"W`, -17.390111, -66.150194],
    ["48°51′29″N 2°17′40″E", 48.858056, 2.294444],
    ["17°23'S 66°09'O", -17.383333, -66.15],
  ])("reads %s", (input, lat, lng) => {
    expect(parseCoordinates(input)).toEqual({ lat, lng });
  });

  it.each(["", "abc", "95, 10", "10, 200", "-17,39, -66,15", "66°W 17°S", "1 2 3"])(
    "refuses %s",
    (input) => {
      expect(parseCoordinates(input)).toBeNull();
    },
  );

  it("formats with six decimals", () => {
    expect(formatCoordinates({ lat: -17.39, lng: -66.1502 })).toBe("-17.390000, -66.150200");
  });
});

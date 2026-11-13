import { describe, expect, it } from "vitest";

import { statisticsRange } from "../visits/statistics";
import { passportCsv, summarizePassport, type PassportStatisticsData } from "./statistics";

const PLAZA = "5eed4100-0000-4000-8000-000000000004";
const MIRADOR = "5eed4100-0000-4000-8000-000000000001";
const FERIA = "5eed4100-0000-4000-8000-000000000002";
const RUTA = "5eed4600-0000-4000-8000-000000000001";
const VIEJA = "5eed4600-0000-4000-8000-000000000002";

const range = statisticsRange("7-dias", "2026-11-12");

function data(stamps: number, extra: Partial<PassportStatisticsData> = {}): PassportStatisticsData {
  return {
    from: range.from,
    to: range.to,
    since: "2026-10-01",
    places: [
      {
        day: null,
        contentId: MIRADOR,
        slug: "mirador",
        title: "Mirador",
        stop: true,
        stamps,
        located: 1,
      },
      {
        day: null,
        contentId: PLAZA,
        slug: "plaza",
        title: "Plaza",
        stop: true,
        stamps: 0,
        located: 0,
      },
    ],
    circuits: [
      {
        day: null,
        circuitId: RUTA,
        slug: "ruta",
        name: "Ruta",
        published: true,
        completed: 2,
        redeemed: 1,
      },
    ],
    ...extra,
  };
}

describe("summarizePassport", () => {
  it("adds up stamps, located stamps, completed circuits and prizes, and compares them", () => {
    const summary = summarizePassport(range, data(6), data(3), new Map([[MIRADOR, 20]]));
    expect(summary.compared).toBe(true);
    expect(summary.totals).toEqual({
      stamps: { value: 6, previous: 3, change: 1 },
      located: { value: 1, previous: 1, change: 0 },
      completed: { value: 2, previous: 2, change: 0 },
      redeemed: { value: 1, previous: 1, change: 0 },
    });
    expect(summary.places.map((place) => [place.title, place.stamps, place.views])).toEqual([
      ["Mirador", 6, 20],
      ["Plaza", 0, 0],
    ]);
    expect(summary.active).toBe(true);
    expect(summary.empty).toBe(false);
  });

  it("does not compare with days before the first counted stamp", () => {
    const summary = summarizePassport(range, data(6, { since: range.previous.to }), data(0));
    expect(summary.compared).toBe(false);
    expect(summary.totals.stamps).toEqual({ value: 6, previous: null, change: null });
    expect(summarizePassport(range, data(6), null).compared).toBe(false);
  });

  it("is inactive without published circuits nor stamps, and lists withdrawn circuits last", () => {
    const none = summarizePassport(range, data(0, { places: [], circuits: [] }), null);
    expect(none).toMatchObject({ active: false, empty: true });
    const withdrawn = summarizePassport(
      range,
      data(0, {
        places: [],
        circuits: [
          {
            day: null,
            circuitId: VIEJA,
            slug: "vieja",
            name: "Antigua",
            published: false,
            completed: 3,
            redeemed: 0,
          },
          {
            day: null,
            circuitId: RUTA,
            slug: "ruta",
            name: "Ruta",
            published: true,
            completed: 0,
            redeemed: 0,
          },
        ],
      }),
      null,
    );
    expect(withdrawn.active).toBe(true);
    expect(withdrawn.circuits.map((circuit) => circuit.name)).toEqual(["Ruta", "Antigua"]);
    expect(withdrawn.empty).toBe(false);
  });

  it("joins the days of a place when asked per day", () => {
    const summary = summarizePassport(
      range,
      data(0, {
        places: [
          {
            day: "2026-11-10",
            contentId: FERIA,
            slug: "feria",
            title: null,
            stop: false,
            stamps: 2,
            located: 2,
          },
          {
            day: "2026-11-11",
            contentId: FERIA,
            slug: "feria",
            title: null,
            stop: false,
            stamps: 1,
            located: 0,
          },
        ],
      }),
      null,
    );
    expect(summary.places).toEqual([
      {
        contentId: FERIA,
        slug: "feria",
        title: "(sin nombre)",
        stop: false,
        views: 0,
        stamps: 3,
        located: 2,
      },
    ]);
  });
});

describe("passportCsv", () => {
  it("writes one row per day and place or circuit, formulas as text", () => {
    const csv = passportCsv(
      data(0, {
        places: [
          {
            day: "2026-11-10",
            contentId: PLAZA,
            slug: "plaza",
            title: "=Plaza",
            stop: true,
            stamps: 2,
            located: 1,
          },
          {
            day: null,
            contentId: PLAZA,
            slug: "plaza",
            title: "Plaza",
            stop: true,
            stamps: 9,
            located: 9,
          },
        ],
        circuits: [
          {
            day: "2026-11-09",
            circuitId: RUTA,
            slug: "ruta",
            name: "Ruta",
            published: true,
            completed: 1,
            redeemed: 0,
          },
        ],
      }),
    );
    expect(csv.split("\r\n").filter(Boolean)).toEqual([
      "﻿fecha;tipo;nombre;dirección;sellos;sellos con ubicación;circuitos completados;premios canjeados",
      "2026-11-09;Circuito;Ruta;ruta;;;1;0",
      "2026-11-10;Sellos de un lugar;'=Plaza;plaza;2;1;;",
    ]);
  });
});

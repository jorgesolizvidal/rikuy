import { describe, expect, it } from "vitest";

import {
  formatDateRange,
  originsCsv,
  parseStatisticsPeriod,
  statisticsRange,
  summarizeStatistics,
  visitsCsv,
  type VisitStatisticsData,
  type VisitStatisticsItem,
} from "./statistics";

const MUSEO = "5eed2000-0000-4000-8000-000000000001";
const FERIA = "5eed2000-0000-4000-8000-000000000002";
const SALA = "5eed4000-0000-4000-8000-000000000001";
const PATIO = "5eed4000-0000-4000-8000-000000000002";

function item(partial: Partial<VisitStatisticsItem>): VisitStatisticsItem {
  return {
    day: null,
    target: "home",
    contentId: null,
    kind: null,
    slug: null,
    title: null,
    sceneId: null,
    sceneTitle: null,
    event: "view",
    views: 0,
    visitors: 0,
    ...partial,
  };
}

const museo = { contentId: MUSEO, kind: "destination", slug: "museo", title: "Museo" } as const;
const feria = { contentId: FERIA, kind: "event", slug: "feria", title: "Feria" } as const;

function data(partial: Partial<VisitStatisticsData>): VisitStatisticsData {
  return { from: "2026-11-06", to: "2026-11-12", items: [], days: [], origins: [], ...partial };
}

describe("statistics periods", () => {
  it("reads the period from the address, or uses the last 30 days", () => {
    expect(parseStatisticsPeriod("7-dias")).toBe("7-dias");
    expect(parseStatisticsPeriod("mes-anterior")).toBe("mes-anterior");
    expect(parseStatisticsPeriod("90-dias")).toBe("30-dias");
    expect(parseStatisticsPeriod(undefined)).toBe("30-dias");
  });

  it("compares the last days with the same number of days before", () => {
    expect(statisticsRange("7-dias", "2026-11-12")).toEqual({
      period: "7-dias",
      from: "2026-11-06",
      to: "2026-11-12",
      previous: { from: "2026-10-30", to: "2026-11-05" },
    });
    expect(statisticsRange("30-dias", "2026-03-01")).toEqual({
      period: "30-dias",
      from: "2026-01-31",
      to: "2026-03-01",
      previous: { from: "2026-01-01", to: "2026-01-30" },
    });
  });

  it("compares this month with the same days of the month before", () => {
    expect(statisticsRange("este-mes", "2026-11-12")).toMatchObject({
      from: "2026-11-01",
      to: "2026-11-12",
      previous: { from: "2026-10-01", to: "2026-10-12" },
    });
    // March 31 compares with all of February (no February 31).
    expect(statisticsRange("este-mes", "2028-03-31").previous).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
    // January compares with December of the year before.
    expect(statisticsRange("este-mes", "2027-01-05").previous).toEqual({
      from: "2026-12-01",
      to: "2026-12-05",
    });
  });

  it("compares last month with the whole month before it", () => {
    expect(statisticsRange("mes-anterior", "2026-11-12")).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-31",
      previous: { from: "2026-09-01", to: "2026-09-30" },
    });
    expect(statisticsRange("mes-anterior", "2027-01-20")).toMatchObject({
      from: "2026-12-01",
      to: "2026-12-31",
      previous: { from: "2026-11-01", to: "2026-11-30" },
    });
  });

  it("refuses a malformed day", () => {
    expect(() => statisticsRange("7-dias", "12/11/2026")).toThrow();
  });

  it("says the dates in Spanish", () => {
    expect(formatDateRange({ from: "2026-10-14", to: "2026-11-12" })).toBe(
      "del 14 oct al 12 nov de 2026",
    );
    expect(formatDateRange({ from: "2026-12-20", to: "2027-01-05" })).toBe(
      "del 20 dic 2026 al 5 ene de 2027",
    );
    expect(formatDateRange({ from: "2026-11-12", to: "2026-11-12" })).toBe("12 nov 2026");
  });
});

describe("statistics summary", () => {
  const range = statisticsRange("7-dias", "2026-11-12");
  const current = data({
    items: [
      item({ target: "home", event: "view", views: 20, visitors: 12 }),
      item({ target: "general_tour", event: "qr", views: 1, visitors: 1 }),
      item({ ...museo, target: "destination", event: "view", views: 8, visitors: 6 }),
      item({ ...museo, target: "destination", event: "qr", views: 3, visitors: 3 }),
      item({ ...museo, target: "destination", event: "directions", views: 2, visitors: 2 }),
      item({ ...feria, target: "event", event: "view", views: 8, visitors: 7 }),
      item({ ...feria, target: "event", event: "calendar", views: 4, visitors: 4 }),
      item({ ...feria, target: "event", event: "share", views: 1, visitors: 1 }),
      item({ ...museo, target: "destination_tour", event: "view", views: 5, visitors: 4 }),
      item({
        ...museo,
        target: "destination_tour",
        event: "scene",
        sceneId: SALA,
        sceneTitle: "Sala",
        views: 9,
        visitors: 4,
      }),
      item({
        ...museo,
        target: "destination_tour",
        event: "scene",
        sceneId: PATIO,
        sceneTitle: null,
        views: 2,
        visitors: 2,
      }),
    ],
    days: [
      { day: "2026-11-10", views: 30, visitors: 15 },
      { day: "2026-11-12", views: 11, visitors: 5 },
    ],
    origins: [
      { day: null, country: "BO", city: "Cliza", views: 30, visitors: 15 },
      { day: null, country: "BO", city: "Punata", views: 5, visitors: 3 },
      { day: null, country: null, city: null, views: 6, visitors: 2 },
      { day: null, country: "AR", city: "Salta", views: 6, visitors: 1 },
    ],
  });
  const previous = data({
    from: "2026-10-30",
    to: "2026-11-05",
    items: [
      item({ target: "home", event: "view", views: 41, visitors: 30 }),
      item({ ...museo, target: "destination", event: "qr", views: 0, visitors: 0 }),
    ],
    days: [{ day: "2026-11-01", views: 41, visitors: 40 }],
  });

  it("adds up the period and compares it when the previous one was counted", () => {
    const summary = summarizeStatistics(range, current, previous, "2026-10-01");
    expect(summary.compared).toBe(true);
    expect(summary.totals.views).toEqual({ value: 41, previous: 41, change: 0 });
    expect(summary.totals.visitors).toEqual({ value: 20, previous: 40, change: -0.5 });
    expect(summary.totals.qr).toEqual({ value: 4, previous: 0, change: null });
    expect(summary.totals.scenes.value).toBe(11);
    expect(summary.totals.calendar.value).toBe(4);
    expect(summary.empty).toBe(false);
  });

  it("does not compare with days that were never counted", () => {
    const summary = summarizeStatistics(range, current, previous, "2026-11-03");
    expect(summary.compared).toBe(false);
    expect(summary.totals.views).toEqual({ value: 41, previous: null, change: null });
    expect(summarizeStatistics(range, current, null, null).compared).toBe(false);
  });

  it("has one day per day of the period, with zeros", () => {
    const summary = summarizeStatistics(range, current, null, null);
    expect(summary.series.map((day) => day.day)).toEqual([
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
    ]);
    expect(summary.series[4]).toEqual({ day: "2026-11-10", views: 30, visitors: 15 });
    expect(summary.series[5]).toEqual({ day: "2026-11-11", views: 0, visitors: 0 });
  });

  it("puts each place's views and actions together, the most viewed first", () => {
    const { places } = summarizeStatistics(range, current, null, null);
    expect(places).toEqual([
      {
        ...feria,
        views: 8,
        visitors: 7,
        qr: 0,
        directions: 0,
        share: 1,
        calendar: 4,
      },
      {
        ...museo,
        views: 8,
        visitors: 6,
        qr: 3,
        directions: 2,
        share: 0,
        calendar: 0,
      },
    ]);
  });

  it("lists each tour with its scenes, deleted ones without a name", () => {
    const { tours } = summarizeStatistics(range, current, null, null);
    expect(tours).toHaveLength(1);
    expect(tours[0]).toMatchObject({ title: "Museo", views: 5, visitors: 4, sceneViews: 11 });
    expect(tours[0]?.scenes).toEqual([
      { sceneId: SALA, title: "Sala", views: 9, visitors: 4 },
      { sceneId: PATIO, title: null, views: 2, visitors: 2 },
    ]);
  });

  it("has every page of the portal, counted or not", () => {
    const { pages } = summarizeStatistics(range, current, null, null);
    expect(pages.map((page) => page.target)).toEqual([
      "home",
      "destinations",
      "agenda",
      "map",
      "general_tour",
    ]);
    expect(pages[0]).toEqual({ target: "home", views: 20, visitors: 12, qr: 0 });
    expect(pages[4]).toEqual({ target: "general_tour", views: 0, visitors: 0, qr: 1 });
  });

  it("adds up countries and cities, the unknown ones last among equals", () => {
    const { countries, cities } = summarizeStatistics(range, current, null, null);
    expect(countries).toEqual([
      { country: "BO", views: 35, visitors: 18 },
      { country: "AR", views: 6, visitors: 1 },
      { country: null, views: 6, visitors: 2 },
    ]);
    expect(cities.map((city) => city.city)).toEqual(["Cliza", "Salta", null, "Punata"]);
  });

  it("is empty without counts", () => {
    expect(summarizeStatistics(range, data({}), null, null).empty).toBe(true);
  });
});

describe("statistics downloads", () => {
  const daily = data({
    items: [
      item({
        ...museo,
        day: "2026-11-12",
        target: "destination",
        event: "view",
        views: 3,
        visitors: 2,
      }),
      item({ day: "2026-11-11", target: "home", event: "view", views: 5, visitors: 4 }),
      item({
        ...museo,
        title: '=HYPERLINK("x";"Museo")',
        day: "2026-11-12",
        target: "destination_tour",
        event: "scene",
        sceneId: SALA,
        sceneTitle: null,
        views: 1,
        visitors: 1,
      }),
    ],
    origins: [
      { day: "2026-11-12", country: "BO", city: "San José; centro", views: 2, visitors: 1 },
      { day: "2026-11-11", country: null, city: null, views: 1, visitors: 1 },
    ],
  });

  it("writes one row per day, page, place, scene and action, for Excel in Spanish", () => {
    const csv = visitsCsv(daily);
    expect(csv.startsWith("﻿fecha;página;lugar;dirección;escena;acción;veces;visitantes\r\n")).toBe(
      true,
    );
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[1]).toBe("2026-11-11;Inicio;;;;Vista de la página;5;4");
    expect(lines[2]).toBe("2026-11-12;Ficha de destino;Museo;museo;;Vista de la página;3;2");
    // A name that looks like a formula is text; a deleted tour's scene says so.
    expect(lines[3]).toBe(
      `2026-11-12;Tour de un destino;"'=HYPERLINK(""x"";""Museo"")";museo;(tour borrado);Escena vista;1;1`,
    );
  });

  it("writes the origins per day, quoting what needs it", () => {
    const lines = originsCsv(daily).trimEnd().split("\r\n");
    expect(lines).toEqual([
      "﻿fecha;país;ciudad;vistas;visitantes",
      "2026-11-11;;;1;1",
      '2026-11-12;BO;"San José; centro";2;1',
    ]);
  });
});

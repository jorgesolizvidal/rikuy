import { describe, expect, it } from "vitest";

import type { OrganizationMembership } from "../../contracts/organization";
import type { PassportStatisticsData } from "../../domain/passport/statistics";
import type { DateRange, VisitStatisticsData } from "../../domain/visits/statistics";
import { downloadStatistics, loadStatistics, type StatisticsRepository } from "./statistics";

const ANALYST: OrganizationMembership = {
  tenantId: "5eed1000-0000-4000-8000-000000000001",
  slug: "demo-norte",
  displayName: "Demo Norte",
  role: "analyst",
  tenantStatus: "active",
};

function repository(
  firstDay: string | null,
  passport: Omit<PassportStatisticsData, "from" | "to"> | null = null,
) {
  const calls: { range: DateRange; daily: boolean }[] = [];
  const passportCalls: { range: DateRange; daily: boolean }[] = [];
  const repo: StatisticsRepository = {
    calendar: async () => ({ timezone: "America/La_Paz", firstDay }),
    passport: async (_tenant, range, daily) => {
      passportCalls.push({ range, daily });
      return passport ? { ...range, ...passport } : null;
    },
    statistics: async (_tenant, range, daily): Promise<VisitStatisticsData> => {
      calls.push({ range, daily });
      return {
        ...range,
        items: [
          {
            day: daily ? range.to : null,
            target: "home",
            contentId: null,
            kind: null,
            slug: null,
            title: null,
            sceneId: null,
            sceneTitle: null,
            event: "view",
            views: range.from === "2026-11-06" ? 10 : 5,
            visitors: 1,
          },
        ],
        days: [],
        origins: [],
      };
    },
  };
  return { repo, calls, passportCalls };
}

// 01:30 on Nov 13 in UTC is still Nov 12 in La Paz: the period ends on the municipality's day.
const NOW = new Date("2026-11-13T01:30:00Z");

describe("statistics use cases", () => {
  it("reads the period and the one before, on the municipality's day", async () => {
    const { repo, calls } = repository("2026-10-01");
    const view = await loadStatistics(ANALYST, repo, "7-dias", NOW);
    expect(view.today).toBe("2026-11-12");
    expect(calls).toEqual([
      { range: { from: "2026-11-06", to: "2026-11-12" }, daily: false },
      { range: { from: "2026-10-30", to: "2026-11-05" }, daily: false },
    ]);
    expect(view.summary.totals.views).toEqual({ value: 10, previous: 5, change: 1 });
  });

  it("does not read the previous period when it was not counted", async () => {
    const { repo, calls } = repository("2026-11-12");
    const view = await loadStatistics(ANALYST, repo, "7-dias", NOW);
    expect(calls).toHaveLength(1);
    expect(view.summary.compared).toBe(false);
    expect(view.firstDay).toBe("2026-11-12");
  });

  it("downloads the period per day, named after the municipality and the dates", async () => {
    const { repo, calls } = repository(null);
    const file = await downloadStatistics(ANALYST, repo, "mes-anterior", "visitas", NOW);
    expect(file.filename).toBe("demo-norte-visitas-2026-10-01-a-2026-10-31.csv");
    expect(calls).toEqual([{ range: { from: "2026-10-01", to: "2026-10-31" }, daily: true }]);
    expect(file.body).toContain("2026-10-31;Inicio;;;;Vista de la página;5;1");
    const origins = await downloadStatistics(ANALYST, repo, "7-dias", "origen", NOW);
    expect(origins.body.startsWith("﻿fecha;país;ciudad")).toBe(true);
  });

  it("adds the passport, with the views of each place's page, when the database counts it", async () => {
    const plaza = "5eed4100-0000-4000-8000-000000000004";
    const { repo, passportCalls } = repository("2026-10-01", {
      since: "2026-10-01",
      places: [
        {
          day: null,
          contentId: plaza,
          slug: "plaza",
          title: "Plaza",
          stop: true,
          stamps: 4,
          located: 3,
        },
      ],
      circuits: [],
    });
    const view = await loadStatistics(ANALYST, repo, "7-dias", NOW);
    expect(passportCalls).toEqual([
      { range: { from: "2026-11-06", to: "2026-11-12" }, daily: false },
      { range: { from: "2026-10-30", to: "2026-11-05" }, daily: false },
    ]);
    expect(view.passport?.totals.stamps).toEqual({ value: 4, previous: 4, change: 0 });
    expect(view.passport?.places[0]).toMatchObject({ title: "Plaza", stamps: 4, located: 3 });

    const before = await loadStatistics(ANALYST, repository("2026-10-01").repo, "7-dias", NOW);
    expect(before.passport).toBeNull();
  });

  it("downloads the passport per day", async () => {
    const { repo, passportCalls } = repository(null, {
      since: "2026-10-31",
      places: [
        {
          day: "2026-10-31",
          contentId: "5eed4100-0000-4000-8000-000000000004",
          slug: "plaza",
          title: "Plaza",
          stop: true,
          stamps: 2,
          located: 1,
        },
      ],
      circuits: [
        {
          day: "2026-10-31",
          circuitId: "5eed4600-0000-4000-8000-000000000001",
          slug: "ruta",
          name: "Ruta",
          published: true,
          completed: 1,
          redeemed: 1,
        },
      ],
    });
    const file = await downloadStatistics(ANALYST, repo, "mes-anterior", "pasaporte", NOW);
    expect(file.filename).toBe("demo-norte-pasaporte-2026-10-01-a-2026-10-31.csv");
    expect(passportCalls).toEqual([
      { range: { from: "2026-10-01", to: "2026-10-31" }, daily: true },
    ]);
    expect(file.body).toContain("2026-10-31;Circuito;Ruta;ruta;;;1;1");
    expect(file.body).toContain("2026-10-31;Sellos de un lugar;Plaza;plaza;2;1;;");
    const empty = await downloadStatistics(
      ANALYST,
      repository(null).repo,
      "7-dias",
      "pasaporte",
      NOW,
    );
    expect(empty.body.split("\r\n").filter(Boolean)).toHaveLength(1);
  });
});

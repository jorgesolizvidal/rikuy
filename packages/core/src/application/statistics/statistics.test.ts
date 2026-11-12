import { describe, expect, it } from "vitest";

import type { OrganizationMembership } from "../../contracts/organization";
import type { DateRange, VisitStatisticsData } from "../../domain/visits/statistics";
import { downloadStatistics, loadStatistics, type StatisticsRepository } from "./statistics";

const ANALYST: OrganizationMembership = {
  tenantId: "5eed1000-0000-4000-8000-000000000001",
  slug: "demo-norte",
  displayName: "Demo Norte",
  role: "analyst",
  tenantStatus: "active",
};

function repository(firstDay: string | null) {
  const calls: { range: DateRange; daily: boolean }[] = [];
  const repo: StatisticsRepository = {
    calendar: async () => ({ timezone: "America/La_Paz", firstDay }),
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
  return { repo, calls };
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
});

import { describe, expect, it } from "vitest";

import type { CopilotReviewRow } from "../../contracts/copilot";
import type { OrganizationMembership } from "../../contracts/organization";
import type { VisitStatisticsData } from "../../domain/visits/statistics";
import type { UnansweredQuestionsData } from "../assistant/unanswered";
import type { CopilotRepository } from "../copilot/ports";
import type { StatisticsRepository } from "../statistics/statistics";
import { loadPanelOverview, type PanelOverviewDeps } from "./overview";

const OWNER: OrganizationMembership = {
  tenantId: "5eed1000-0000-4000-8000-000000000001",
  slug: "demo-norte",
  displayName: "Demo Norte",
  role: "owner",
  tenantStatus: "active",
};
const NOW = new Date("2026-11-13T01:30:00Z");

function statistics(firstDay: string | null): StatisticsRepository & { passportCalls: number } {
  const repo = {
    passportCalls: 0,
    calendar: async () => ({ timezone: "America/La_Paz", firstDay }),
    passport: async () => {
      repo.passportCalls += 1;
      return null;
    },
    statistics: async (_t: string, range: { from: string; to: string }) =>
      ({
        ...range,
        items: [
          {
            day: null,
            target: "home",
            contentId: null,
            kind: null,
            slug: null,
            title: null,
            sceneId: null,
            sceneTitle: null,
            event: "view",
            views: range.from === "2026-11-06" ? 30 : 20,
            visitors: range.from === "2026-11-06" ? 12 : 8,
          },
        ],
        days: [{ day: range.to, views: 0, visitors: range.from === "2026-11-06" ? 12 : 8 }],
        origins: [],
      }) as VisitStatisticsData,
  };
  return repo;
}

const row = (contentId: string, sceneId: string | null): CopilotReviewRow => ({
  kind: "destination",
  contentId,
  slug: contentId,
  tourId: sceneId ? "t" : null,
  sceneId,
  title: contentId,
  sceneTitle: sceneId,
  status: "published",
  issues: [{ code: "summary_short" } as never],
});

function deps(overrides: Partial<PanelOverviewDeps> = {}) {
  const asked: number[] = [];
  const base: PanelOverviewDeps = {
    statistics: statistics("2026-10-01"),
    questions: {
      unansweredQuestions: async (_tenant, days) => {
        asked.push(days);
        return {
          from: "2026-11-06",
          to: "2026-11-12",
          since: "2026-11-01",
          total: 5,
          people: 4,
          groups: [{ key: "a" }, { key: "b" }],
        } as unknown as UnansweredQuestionsData;
      },
    },
    copilot: {
      review: async () => [row("museo", null), row("museo", null), row("plaza", "s1")],
    } as unknown as CopilotRepository,
    content: {
      portalHostname: async () => "demo-norte.localhost",
      listDestinations: async () =>
        [{ status: "published" }, { status: "changed" }, { status: "draft" }] as never,
      listEvents: async () => [{ status: "draft" }] as never,
    },
    ...overrides,
  };
  return { deps: base, asked };
}

describe("the panel's summary (ADR-066)", () => {
  it("reads the portal, the last 7 days, the questions, the review and the content", async () => {
    const { deps: d, asked } = deps();
    const overview = await loadPanelOverview(OWNER, d, NOW);
    expect(overview.portal).toEqual({ online: true, hostname: "demo-norte.localhost" });
    expect(overview.visits).toEqual({
      views: { value: 30, previous: 20, change: 0.5 },
      visitors: 12,
      counting: false,
    });
    expect(asked).toEqual([7]);
    expect(overview.questions).toEqual({ total: 5, distinct: 2 });
    expect(overview.review).toEqual({ contents: 1, scenes: 1 });
    expect(overview.content).toEqual({
      destinations: { published: 2, drafts: 1, changed: 1 },
      events: { published: 0, drafts: 1, changed: 0 },
    });
    // The passport has its own section in «Estadísticas»: not read here.
    expect((d.statistics as ReturnType<typeof statistics>).passportCalls).toBe(0);
  });

  it("leaves out the modules the municipality does not have", async () => {
    const { deps: d, asked } = deps();
    const overview = await loadPanelOverview(
      { ...OWNER, tenantStatus: "provisioning", modules: [] },
      d,
      NOW,
    );
    expect(overview.portal.online).toBe(false);
    expect(asked).toEqual([]);
    expect(overview.questions).toBeNull();
    expect(overview.review).toBeNull();
    expect(overview.content?.events).toBeNull();
  });

  it("without a comparison when the week before was not counted; nothing counted yet", async () => {
    const recent = await loadPanelOverview(
      OWNER,
      deps({ statistics: statistics("2026-11-10") }).deps,
      NOW,
    );
    expect(recent.visits?.views).toEqual({ value: 30, previous: null, change: null });
    expect(recent.visits?.counting).toBe(false);
    const none = await loadPanelOverview(OWNER, deps({ statistics: statistics(null) }).deps, NOW);
    expect(none.visits?.counting).toBe(true);
  });

  it("a part that cannot be read is left out, never a zero", async () => {
    const fail = async () => {
      throw new Error("down");
    };
    const overview = await loadPanelOverview(
      OWNER,
      deps({
        statistics: { ...statistics("2026-10-01"), calendar: fail },
        questions: { unansweredQuestions: fail },
        copilot: { review: fail } as unknown as CopilotRepository,
        content: { portalHostname: fail, listDestinations: fail, listEvents: fail },
      }).deps,
      NOW,
    );
    expect(overview).toEqual({
      portal: { online: true, hostname: null },
      visits: null,
      questions: null,
      review: null,
      content: null,
    });
  });
});

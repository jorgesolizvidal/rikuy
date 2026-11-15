import type { OrganizationMembership } from "../../contracts/organization";
import { hasModule, MODULE_KEYS } from "../../domain/tenancy/modules";
import type { Measure } from "../../domain/visits/statistics";
import type { UnansweredQuestionsRepository } from "../assistant/unanswered";
import type { ContentRepository, ContentStatus } from "../content/ports";
import type { CopilotRepository } from "../copilot/ports";
import { copilotForModules } from "../copilot/modules";
import { loadStatistics, type StatisticsRepository } from "../statistics/statistics";

/**
 * The summary at the top of a municipality's panel (C3 · Paso 7, ADR-066): where its portal
 * stands, its visits in the last 7 days, what visitors asked without an answer and what the
 * Copilot's review says is missing. Only real numbers, read with the person's session: a part
 * that cannot be read (or a module the municipality does not have) is left out, never shown as
 * a zero.
 */

export interface PanelContentCounts {
  readonly published: number;
  /** Never published. */
  readonly drafts: number;
  /** Published, with changes not published yet. */
  readonly changed: number;
}

export interface PanelOverview {
  readonly portal: {
    /** «En línea» or «En preparación» (a suspended municipality does not open). */
    readonly online: boolean;
    /** Its address; null when it has none yet or it could not be read. */
    readonly hostname: string | null;
  };
  /** The last 7 days; null when they could not be read. */
  readonly visits: {
    /** Page views, against the 7 days before (no previous when those were not counted). */
    readonly views: Measure;
    readonly visitors: number;
    /** Nothing has been counted yet. */
    readonly counting: boolean;
  } | null;
  /** The last 7 days (ADR-053); null without the assistant or when they could not be read. */
  readonly questions: { readonly total: number; readonly distinct: number } | null;
  /** The Copilot's review (ADR-042); null without the Copilot or when it could not be read. */
  readonly review: { readonly contents: number; readonly scenes: number } | null;
  /** Destinations, and events with the agenda; null when they could not be read. */
  readonly content: {
    readonly destinations: PanelContentCounts;
    readonly events: PanelContentCounts | null;
  } | null;
}

export interface PanelOverviewDeps {
  readonly statistics: StatisticsRepository;
  readonly questions: UnansweredQuestionsRepository;
  readonly copilot: CopilotRepository;
  readonly content: Pick<ContentRepository, "listDestinations" | "listEvents" | "portalHostname">;
}

function counts(items: readonly { readonly status: ContentStatus }[]): PanelContentCounts {
  return {
    published: items.filter((item) => item.status !== "draft").length,
    drafts: items.filter((item) => item.status === "draft").length,
    changed: items.filter((item) => item.status === "changed").length,
  };
}

async function settle<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

export async function loadPanelOverview(
  membership: OrganizationMembership,
  deps: PanelOverviewDeps,
  now: Date = new Date(),
): Promise<PanelOverview> {
  const tenantId = membership.tenantId;
  const has = (key: Parameters<typeof hasModule>[1]) => hasModule(membership.modules, key);
  // The visits alone: the passport has its own section in «Estadísticas».
  const visitsOnly: OrganizationMembership = {
    ...membership,
    modules: (membership.modules ?? MODULE_KEYS).filter((key) => key !== "passport"),
  };

  const [hostname, visits, questions, review, destinations, events] = await Promise.all([
    settle(() => deps.content.portalHostname(tenantId)),
    settle(async () => {
      const { summary, firstDay } = await loadStatistics(
        visitsOnly,
        deps.statistics,
        "7-dias",
        now,
      );
      return {
        views: summary.compared
          ? summary.totals.views
          : { value: summary.totals.views.value, previous: null, change: null },
        visitors: summary.totals.visitors.value,
        counting: firstDay === null,
      };
    }),
    has("assistant")
      ? settle(async () => {
          const data = await deps.questions.unansweredQuestions(tenantId, 7);
          return { total: data.total, distinct: data.groups.length };
        })
      : Promise.resolve(null),
    has("copilot")
      ? settle(async () => {
          const rows = await copilotForModules(deps.copilot, membership.modules).review(tenantId);
          return {
            contents: new Set(
              rows.filter((row) => row.sceneId === null).map((row) => row.contentId),
            ).size,
            scenes: rows.filter((row) => row.sceneId !== null).length,
          };
        })
      : Promise.resolve(null),
    settle(() => deps.content.listDestinations(tenantId)),
    has("agenda") ? settle(() => deps.content.listEvents(tenantId)) : Promise.resolve(null),
  ]);

  return {
    portal: { online: membership.tenantStatus === "active", hostname },
    visits,
    questions,
    review,
    content: destinations
      ? { destinations: counts(destinations), events: events ? counts(events) : null }
      : null,
  };
}

import type { OrganizationMembership } from "../../contracts/organization";
import type { AssistantPageKind } from "../../domain/assistant/page";

/**
 * «Lo que preguntan los visitantes» (C1 · Paso 3, ADR-053): the questions the assistant could
 * not answer, grouped by their words, for every member of the municipality (owners and
 * admins with their second factor, ADR-043). The database checks it again and keeps them 90
 * days, so the periods go up to that.
 */

export const UNANSWERED_PERIODS = ["7-dias", "30-dias", "90-dias"] as const;
export type UnansweredPeriod = (typeof UNANSWERED_PERIODS)[number];

export const UNANSWERED_PERIOD_LABELS: Readonly<Record<UnansweredPeriod, string>> = {
  "7-dias": "Últimos 7 días",
  "30-dias": "Últimos 30 días",
  "90-dias": "Últimos 90 días",
};

const DAYS: Readonly<Record<UnansweredPeriod, 7 | 30 | 90>> = {
  "7-dias": 7,
  "30-dias": 30,
  "90-dias": 90,
};

export function parseUnansweredPeriod(raw: unknown): UnansweredPeriod {
  return UNANSWERED_PERIODS.find((period) => period === raw) ?? "30-dias";
}

/** One page a question was asked on. */
export interface UnansweredPage {
  readonly pageKind: AssistantPageKind;
  readonly contentId: string | null;
  readonly kind: "destination" | "event" | null;
  readonly slug: string | null;
  /** The place's published name (or its draft's, if it was never published). */
  readonly title: string | null;
  /** Inside a tour: the scene's name. */
  readonly sceneTitle: string | null;
  readonly times: number;
}

/** The questions with the same words. */
export interface UnansweredGroup {
  readonly key: string;
  /** The newest wording. */
  readonly text: string;
  readonly times: number;
  /** Distinct people per day, added up (as in «Estadísticas»). */
  readonly people: number;
  readonly firstAsked: string;
  readonly lastAsked: string;
  /** The municipality's day it was last asked. */
  readonly lastDay: string;
  readonly langs: readonly ("es" | "en")[];
  /** Up to three pages, the most frequent first. */
  readonly pages: readonly UnansweredPage[];
}

export interface UnansweredQuestionsData {
  readonly from: string;
  readonly to: string;
  /** The first day any question was kept (null: none yet). */
  readonly since: string | null;
  readonly total: number;
  readonly people: number;
  /** The most asked first, at most 200. */
  readonly groups: readonly UnansweredGroup[];
}

export interface UnansweredQuestionsRepository {
  unansweredQuestions(tenantId: string, days: 7 | 30 | 90): Promise<UnansweredQuestionsData>;
}

export async function loadUnansweredQuestions(
  membership: OrganizationMembership,
  repository: UnansweredQuestionsRepository,
  period: UnansweredPeriod,
): Promise<UnansweredQuestionsData> {
  return repository.unansweredQuestions(membership.tenantId, DAYS[period]);
}

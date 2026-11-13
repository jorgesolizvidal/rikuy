import type { OrganizationMembership } from "../../contracts/organization";
import { localClock } from "../../domain/plan/clock";
import {
  passportCsv,
  summarizePassport,
  type PassportStatisticsData,
  type PassportSummary,
} from "../../domain/passport/statistics";
import {
  originsCsv,
  statisticsRange,
  summarizeStatistics,
  visitsCsv,
  type DateRange,
  type StatisticsPeriod,
  type StatisticsRange,
  type StatisticsSummary,
  type VisitStatisticsData,
} from "../../domain/visits/statistics";

/**
 * «Estadísticas» (C1 · Paso 2, ADR-052), with the signed-in user's session. Every member of
 * the municipality reads them (owners and admins with their second factor, ADR-043); the
 * database checks it again.
 */
export interface StatisticsRepository {
  /** The municipality's time zone and its first counted day (null: nothing counted yet). */
  calendar(
    tenantId: string,
  ): Promise<{ readonly timezone: string; readonly firstDay: string | null }>;
  /** The totals of a period; per day when `daily`. */
  statistics(tenantId: string, range: DateRange, daily: boolean): Promise<VisitStatisticsData>;
  /**
   * The tourist passport of a period (C2 · Paso 4, ADR-059); per day when `daily`. Null
   * before the database has it (the web app may be deployed a few minutes earlier).
   */
  passport(
    tenantId: string,
    range: DateRange,
    daily: boolean,
  ): Promise<PassportStatisticsData | null>;
}

export interface StatisticsView {
  readonly summary: StatisticsSummary;
  /** Null before the database counts the passport. */
  readonly passport: PassportSummary | null;
  readonly firstDay: string | null;
  /** The municipality's date today. */
  readonly today: string;
}

async function rangeFor(
  membership: OrganizationMembership,
  repository: StatisticsRepository,
  period: StatisticsPeriod,
  now: Date,
): Promise<{ range: StatisticsRange; firstDay: string | null; today: string }> {
  const calendar = await repository.calendar(membership.tenantId);
  const today = localClock(now, calendar.timezone).date;
  return { range: statisticsRange(period, today), firstDay: calendar.firstDay, today };
}

export async function loadStatistics(
  membership: OrganizationMembership,
  repository: StatisticsRepository,
  period: StatisticsPeriod,
  now: Date = new Date(),
): Promise<StatisticsView> {
  const { range, firstDay, today } = await rangeFor(membership, repository, period, now);
  // Nothing to compare with when the previous period was not counted entirely.
  const comparable = firstDay !== null && range.previous.from >= firstDay;
  const days = { from: range.from, to: range.to };
  const [current, previous, passport, passportBefore] = await Promise.all([
    repository.statistics(membership.tenantId, days, false),
    comparable ? repository.statistics(membership.tenantId, range.previous, false) : null,
    repository.passport(membership.tenantId, days, false),
    repository.passport(membership.tenantId, range.previous, false),
  ]);
  const summary = summarizeStatistics(range, current, previous, firstDay);
  return {
    summary,
    passport: passport
      ? summarizePassport(range, passport, passportBefore, viewsOf(summary))
      : null,
    firstDay,
    today,
  };
}

/** The views of each place's page (content id → views), for the passport's table. */
export function viewsOf(summary: StatisticsSummary): Map<string, number> {
  return new Map(summary.places.map((place) => [place.contentId, place.views]));
}

export const STATISTICS_DOWNLOADS = ["visitas", "origen", "pasaporte"] as const;
export type StatisticsDownload = (typeof STATISTICS_DOWNLOADS)[number];

export function parseStatisticsDownload(raw: unknown): StatisticsDownload | null {
  return STATISTICS_DOWNLOADS.find((kind) => kind === raw) ?? null;
}

export interface StatisticsFile {
  readonly filename: string;
  readonly body: string;
}

/** The period's totals per day, as a CSV for a spreadsheet. */
export async function downloadStatistics(
  membership: OrganizationMembership,
  repository: StatisticsRepository,
  period: StatisticsPeriod,
  kind: StatisticsDownload,
  now: Date = new Date(),
): Promise<StatisticsFile> {
  const { range } = await rangeFor(membership, repository, period, now);
  const days = { from: range.from, to: range.to };
  const filename = `${membership.slug}-${kind}-${range.from}-a-${range.to}.csv`;
  if (kind === "pasaporte") {
    const data = await repository.passport(membership.tenantId, days, true);
    return {
      filename,
      body: passportCsv(data ?? { ...days, since: null, places: [], circuits: [] }),
    };
  }
  const data = await repository.statistics(membership.tenantId, days, true);
  return { filename, body: kind === "visitas" ? visitsCsv(data) : originsCsv(data) };
}

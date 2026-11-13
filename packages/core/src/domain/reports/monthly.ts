import type { RecommendationPeriod } from "../copilot/recommendations";
import { statisticsRange, type StatisticsRange } from "../visits/statistics";

/**
 * The monthly report for the town hall (C1 · Paso 5, ADR-055): one calendar month of the
 * municipality. A month that ended is compared with the whole month before; the current one,
 * with the same days of the month before (as «Este mes» in «Estadísticas»).
 */

/** «2026-11». */
export type ReportMonth = string;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/u;

const MONTH_NAMES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/** How many months back the panel offers (the database accepts up to 24). */
export const REPORT_MONTHS_BACK = 12;

export function isReportMonth(raw: unknown): raw is ReportMonth {
  return typeof raw === "string" && MONTH.test(raw);
}

/** The month of a date (YYYY-MM-DD). */
export function monthOf(date: string): ReportMonth {
  return date.slice(0, 7);
}

/** «2026-11» → «2026-11-01». */
export function monthStartDate(month: ReportMonth): string {
  return `${month}-01`;
}

export function addMonths(month: ReportMonth, delta: number): ReportMonth {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const index = year * 12 + (number - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** «noviembre de 2026». */
export function formatMonth(month: ReportMonth): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return `${MONTH_NAMES[number - 1]} de ${year}`;
}

/** «Noviembre de 2026». */
export function formatMonthTitle(month: ReportMonth): string {
  const text = formatMonth(month);
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * The month asked for, when it is one the panel offers: not in the future and at most
 * REPORT_MONTHS_BACK months back. Anything else is the default: the month that ended.
 */
export function parseReportMonth(raw: unknown, today: string): ReportMonth {
  const current = monthOf(today);
  const fallback = addMonths(current, -1);
  if (!isReportMonth(raw)) return fallback;
  if (raw > current || raw < addMonths(current, -REPORT_MONTHS_BACK)) return fallback;
  return raw;
}

/** The months the panel offers, newest first: this one and the 12 before. */
export function reportMonths(today: string): ReportMonth[] {
  const current = monthOf(today);
  return Array.from({ length: REPORT_MONTHS_BACK + 1 }, (_, index) => addMonths(current, -index));
}

/** The month's days (to today for the current one) and what they are compared with. */
export function monthlyReportRange(month: ReportMonth, today: string): StatisticsRange {
  if (!isReportMonth(month)) throw new Error("month must be YYYY-MM");
  const current = monthOf(today);
  if (month > current) throw new Error("the month is in the future");
  if (month === current) return statisticsRange("este-mes", today);
  // «Mes anterior» as seen from the 1st of the month after.
  return statisticsRange("mes-anterior", monthStartDate(addMonths(month, 1)));
}

/** True while the month has not ended. */
export function isCurrentMonth(month: ReportMonth, today: string): boolean {
  return month === monthOf(today);
}

/** How the Copilot's facts name the month and what it is compared with. */
export function monthlyRecommendationPeriod(
  month: ReportMonth,
  today: string,
): RecommendationPeriod {
  return isCurrentMonth(month, today)
    ? { name: `${formatMonth(month)}, hasta hoy`, previous: "los mismos días del mes anterior" }
    : { name: formatMonth(month), previous: "el mes anterior" };
}

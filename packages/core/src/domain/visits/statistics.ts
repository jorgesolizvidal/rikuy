import type { VisitEvent, VisitTarget } from "./visit";

/**
 * «Estadísticas» (C1 · Paso 2, ADR-052): the municipality's daily totals (ADR-051) added up
 * for a period and compared with the one before. Days are the municipality's (its time zone);
 * a period includes both ends. Nothing here identifies a visitor.
 */

/** Visits are counted on destinations and events (and their tours). */
export type StatisticsContentKind = "destination" | "event";

// ── Periods ──────────────────────────────────────────────────────────────────

export const STATISTICS_PERIODS = ["7-dias", "30-dias", "este-mes", "mes-anterior"] as const;
export type StatisticsPeriod = (typeof STATISTICS_PERIODS)[number];
export const DEFAULT_STATISTICS_PERIOD: StatisticsPeriod = "30-dias";

export const STATISTICS_PERIOD_LABELS: Readonly<Record<StatisticsPeriod, string>> = {
  "7-dias": "Últimos 7 días",
  "30-dias": "Últimos 30 días",
  "este-mes": "Este mes",
  "mes-anterior": "Mes anterior",
};

export function parseStatisticsPeriod(raw: unknown): StatisticsPeriod {
  return STATISTICS_PERIODS.find((period) => period === raw) ?? DEFAULT_STATISTICS_PERIOD;
}

export interface DateRange {
  /** YYYY-MM-DD, included. */
  readonly from: string;
  /** YYYY-MM-DD, included. */
  readonly to: string;
}

export interface StatisticsRange extends DateRange {
  readonly period: StatisticsPeriod;
  /** What it is compared with: the same number of days just before (the same days of the
   * month before, for «Este mes»; the whole month before, for «Mes anterior»). */
  readonly previous: DateRange;
}

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

function toDay(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

function fromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromDay(toDay(date) + days);
}

/** Days between two dates, both included (0 when `to` is before `from`). */
export function daysIn(range: DateRange): number {
  return Math.max(0, toDay(range.to) - toDay(range.from) + 1);
}

function monthStart(year: number, month: number): string {
  const date = new Date(Date.UTC(year, month, 1));
  return date.toISOString().slice(0, 10);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The period that ends today (the municipality's date, YYYY-MM-DD) and the one before it. */
export function statisticsRange(period: StatisticsPeriod, today: string): StatisticsRange {
  if (!DATE.test(today)) throw new Error("today must be YYYY-MM-DD");
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  switch (period) {
    case "7-dias":
    case "30-dias": {
      const length = period === "7-dias" ? 7 : 30;
      const from = addDays(today, -(length - 1));
      return {
        period,
        from,
        to: today,
        previous: { from: addDays(from, -length), to: addDays(from, -1) },
      };
    }
    case "este-mes": {
      const previousStart = monthStart(year, month - 2);
      const previousLast = lastDayOfMonth(year, month - 2);
      return {
        period,
        from: monthStart(year, month - 1),
        to: today,
        previous: {
          from: previousStart,
          to: addDays(previousStart, Math.min(day, previousLast) - 1),
        },
      };
    }
    case "mes-anterior": {
      const from = monthStart(year, month - 2);
      const previousFrom = monthStart(year, month - 3);
      return {
        period,
        from,
        to: addDays(monthStart(year, month - 1), -1),
        previous: { from: previousFrom, to: addDays(from, -1) },
      };
    }
  }
}

const MONTHS = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sept",
  "oct",
  "nov",
  "dic",
];

function shortDate(date: string, withYear: boolean): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return `${day} ${MONTHS[month - 1]}${withYear ? ` ${year}` : ""}`;
}

/** «del 14 oct al 12 nov de 2026», «12 nov 2026» for a single day. */
export function formatDateRange(range: DateRange): string {
  if (range.from === range.to) return shortDate(range.from, true);
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  const to = shortDate(range.to, false);
  return `del ${shortDate(range.from, !sameYear)} al ${to} de ${range.to.slice(0, 4)}`;
}

/** «12 nov 2026». */
export function formatShortDate(date: string): string {
  return shortDate(date, true);
}

// ── What the database returns ───────────────────────────────────────────────

export interface VisitStatisticsItem {
  /** Only when asked per day. */
  readonly day: string | null;
  readonly target: VisitTarget;
  readonly contentId: string | null;
  readonly kind: StatisticsContentKind | null;
  readonly slug: string | null;
  readonly title: string | null;
  readonly sceneId: string | null;
  readonly sceneTitle: string | null;
  readonly event: VisitEvent;
  readonly views: number;
  readonly visitors: number;
}

export interface VisitStatisticsDay {
  readonly day: string;
  /** Page views (not scenes, nor actions). */
  readonly views: number;
  /** Distinct visitors of the whole portal that day. */
  readonly visitors: number;
}

export interface VisitStatisticsOrigin {
  readonly day: string | null;
  readonly country: string | null;
  readonly city: string | null;
  readonly views: number;
  readonly visitors: number;
}

export interface VisitStatisticsData extends DateRange {
  readonly items: readonly VisitStatisticsItem[];
  readonly days: readonly VisitStatisticsDay[];
  readonly origins: readonly VisitStatisticsOrigin[];
}

// ── The summary ─────────────────────────────────────────────────────────────

export interface Measure {
  readonly value: number;
  /** The previous period's value; null when there is nothing to compare with. */
  readonly previous: number | null;
  /** (value − previous) / previous; null without a previous value or when it was 0. */
  readonly change: number | null;
}

export const STATISTICS_TOTALS = [
  "views",
  "visitors",
  "qr",
  "directions",
  "share",
  "calendar",
  "scenes",
] as const;
export type StatisticsTotal = (typeof STATISTICS_TOTALS)[number];

export interface PlaceStatistics {
  readonly contentId: string;
  readonly kind: StatisticsContentKind | null;
  readonly slug: string | null;
  readonly title: string;
  readonly views: number;
  readonly visitors: number;
  readonly qr: number;
  readonly directions: number;
  readonly share: number;
  readonly calendar: number;
}

export interface SceneStatistics {
  readonly sceneId: string;
  /** null once its tour was deleted. */
  readonly title: string | null;
  readonly views: number;
  readonly visitors: number;
}

export interface TourStatistics {
  readonly contentId: string;
  readonly kind: StatisticsContentKind | null;
  readonly slug: string | null;
  readonly title: string;
  readonly views: number;
  readonly visitors: number;
  readonly qr: number;
  readonly sceneViews: number;
  readonly scenes: readonly SceneStatistics[];
}

export const PORTAL_PAGES = ["home", "destinations", "agenda", "map", "general_tour"] as const;
export type PortalPageTarget = (typeof PORTAL_PAGES)[number];

/** Every page that counts (the database has the same list). */
export const VISIT_TARGETS = [
  ...PORTAL_PAGES,
  "destination",
  "event",
  "destination_tour",
  "event_tour",
] as const satisfies readonly VisitTarget[];

export interface PageStatistics {
  readonly target: PortalPageTarget;
  readonly views: number;
  readonly visitors: number;
  readonly qr: number;
}

export interface CountryStatistics {
  /** null: the CDN could not tell. */
  readonly country: string | null;
  readonly views: number;
  readonly visitors: number;
}

export interface CityStatistics extends CountryStatistics {
  readonly city: string | null;
}

export interface StatisticsSummary {
  readonly range: StatisticsRange;
  /** False when the previous period starts before the first counted day. */
  readonly compared: boolean;
  readonly totals: Readonly<Record<StatisticsTotal, Measure>>;
  /** One entry per day of the period, zeros included. */
  readonly series: readonly VisitStatisticsDay[];
  readonly places: readonly PlaceStatistics[];
  readonly tours: readonly TourStatistics[];
  readonly pages: readonly PageStatistics[];
  readonly countries: readonly CountryStatistics[];
  readonly cities: readonly CityStatistics[];
  readonly empty: boolean;
}

const UNNAMED = "(sin nombre)";

function totalsOf(data: VisitStatisticsData): Record<StatisticsTotal, number> {
  const sum = (event: VisitEvent) =>
    data.items
      .filter((item) => item.event === event)
      .reduce((total, item) => total + item.views, 0);
  return {
    views: sum("view"),
    visitors: data.days.reduce((total, day) => total + day.visitors, 0),
    qr: sum("qr"),
    directions: sum("directions"),
    share: sum("share"),
    calendar: sum("calendar"),
    scenes: sum("scene"),
  };
}

/** A value and how it changed from the previous period's (null: nothing to compare). */
export function measure(value: number, previous: number | null): Measure {
  return {
    value,
    previous,
    change: previous === null || previous === 0 ? null : (value - previous) / previous,
  };
}

function byNumbers<T extends { readonly views: number; readonly title: string | null }>(
  a: T,
  b: T,
): number {
  return b.views - a.views || (a.title ?? "").localeCompare(b.title ?? "", "es");
}

function seriesOf(data: VisitStatisticsData, range: DateRange): VisitStatisticsDay[] {
  const known = new Map(data.days.map((day) => [day.day, day]));
  return Array.from({ length: daysIn(range) }, (_, index) => {
    const day = addDays(range.from, index);
    return known.get(day) ?? { day, views: 0, visitors: 0 };
  });
}

function placesOf(items: readonly VisitStatisticsItem[]): PlaceStatistics[] {
  const places = new Map<string, PlaceStatistics>();
  for (const item of items) {
    if ((item.target !== "destination" && item.target !== "event") || !item.contentId) continue;
    const place = places.get(item.contentId) ?? {
      contentId: item.contentId,
      kind: item.kind,
      slug: item.slug,
      title: item.title ?? UNNAMED,
      views: 0,
      visitors: 0,
      qr: 0,
      directions: 0,
      share: 0,
      calendar: 0,
    };
    places.set(item.contentId, {
      ...place,
      views: place.views + (item.event === "view" ? item.views : 0),
      visitors: place.visitors + (item.event === "view" ? item.visitors : 0),
      qr: place.qr + (item.event === "qr" ? item.views : 0),
      directions: place.directions + (item.event === "directions" ? item.views : 0),
      share: place.share + (item.event === "share" ? item.views : 0),
      calendar: place.calendar + (item.event === "calendar" ? item.views : 0),
    });
  }
  return [...places.values()].sort(byNumbers);
}

function toursOf(items: readonly VisitStatisticsItem[]): TourStatistics[] {
  const tours = new Map<string, TourStatistics>();
  const scenes = new Map<string, Map<string, SceneStatistics>>();
  for (const item of items) {
    if ((item.target !== "destination_tour" && item.target !== "event_tour") || !item.contentId) {
      continue;
    }
    const tour = tours.get(item.contentId) ?? {
      contentId: item.contentId,
      kind: item.kind,
      slug: item.slug,
      title: item.title ?? UNNAMED,
      views: 0,
      visitors: 0,
      qr: 0,
      sceneViews: 0,
      scenes: [],
    };
    tours.set(item.contentId, {
      ...tour,
      views: tour.views + (item.event === "view" ? item.views : 0),
      visitors: tour.visitors + (item.event === "view" ? item.visitors : 0),
      qr: tour.qr + (item.event === "qr" ? item.views : 0),
      sceneViews: tour.sceneViews + (item.event === "scene" ? item.views : 0),
    });
    if (item.event === "scene" && item.sceneId) {
      const ofTour = scenes.get(item.contentId) ?? new Map<string, SceneStatistics>();
      const scene = ofTour.get(item.sceneId) ?? {
        sceneId: item.sceneId,
        title: item.sceneTitle,
        views: 0,
        visitors: 0,
      };
      ofTour.set(item.sceneId, {
        ...scene,
        views: scene.views + item.views,
        visitors: scene.visitors + item.visitors,
      });
      scenes.set(item.contentId, ofTour);
    }
  }
  return [...tours.values()]
    .map((tour) => ({
      ...tour,
      scenes: [...(scenes.get(tour.contentId)?.values() ?? [])].sort(byNumbers),
    }))
    .sort((a, b) => b.views + b.sceneViews - (a.views + a.sceneViews) || byNumbers(a, b));
}

function pagesOf(items: readonly VisitStatisticsItem[]): PageStatistics[] {
  return PORTAL_PAGES.map((target) => {
    const ofPage = items.filter((item) => item.target === target);
    const sum = (event: VisitEvent, field: "views" | "visitors") =>
      ofPage.filter((item) => item.event === event).reduce((total, item) => total + item[field], 0);
    return {
      target,
      views: sum("view", "views"),
      visitors: sum("view", "visitors"),
      qr: sum("qr", "views"),
    };
  });
}

function originsOf(origins: readonly VisitStatisticsOrigin[]) {
  const countries = new Map<string, CountryStatistics>();
  const cities = new Map<string, CityStatistics>();
  for (const origin of origins) {
    const countryKey = origin.country ?? "";
    const country = countries.get(countryKey) ?? {
      country: origin.country,
      views: 0,
      visitors: 0,
    };
    countries.set(countryKey, {
      ...country,
      views: country.views + origin.views,
      visitors: country.visitors + origin.visitors,
    });
    const cityKey = `${countryKey}|${origin.city ?? ""}`;
    const city = cities.get(cityKey) ?? {
      country: origin.country,
      city: origin.city,
      views: 0,
      visitors: 0,
    };
    cities.set(cityKey, {
      ...city,
      views: city.views + origin.views,
      visitors: city.visitors + origin.visitors,
    });
  }
  const order = (a: CountryStatistics, b: CountryStatistics) =>
    b.views - a.views ||
    Number(a.country === null) - Number(b.country === null) ||
    (a.country ?? "").localeCompare(b.country ?? "");
  return {
    countries: [...countries.values()].sort(order),
    cities: [...cities.values()].sort(order),
  };
}

/**
 * The period's numbers and, when the previous period was counted entirely (it starts on or
 * after `firstDay`), how they changed.
 */
export function summarizeStatistics(
  range: StatisticsRange,
  current: VisitStatisticsData,
  previous: VisitStatisticsData | null,
  firstDay: string | null,
): StatisticsSummary {
  const compared = previous !== null && firstDay !== null && range.previous.from >= firstDay;
  const now = totalsOf(current);
  const before = compared && previous ? totalsOf(previous) : null;
  const totals = Object.fromEntries(
    STATISTICS_TOTALS.map((key) => [key, measure(now[key], before ? before[key] : null)]),
  ) as Record<StatisticsTotal, Measure>;
  return {
    range,
    compared,
    totals,
    series: seriesOf(current, range),
    places: placesOf(current.items),
    tours: toursOf(current.items),
    pages: pagesOf(current.items),
    ...originsOf(current.origins),
    empty: current.items.length === 0 && current.origins.length === 0,
  };
}

// ── CSV ─────────────────────────────────────────────────────────────────────

export const VISIT_TARGET_LABELS: Readonly<Record<VisitTarget, string>> = {
  home: "Inicio",
  destinations: "Destinos",
  agenda: "Agenda",
  map: "Mapa",
  general_tour: "Recorrido general",
  destination: "Ficha de destino",
  event: "Ficha de evento",
  destination_tour: "Tour de un destino",
  event_tour: "Tour de un evento",
};

export const VISIT_EVENT_LABELS: Readonly<Record<VisitEvent, string>> = {
  view: "Vista de la página",
  scene: "Escena vista",
  directions: "Cómo llegar",
  share: "Compartir",
  calendar: "Añadir al calendario",
  qr: "Escaneo de QR",
};

/** Excel in Spanish uses «;» to separate columns; the BOM makes it read the accents. */
const CSV_SEPARATOR = ";";
const BOM = "﻿";

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  // A cell that starts like a formula is opened as text, never run by the spreadsheet.
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return /[";\n\r,]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** A CSV that Excel in Spanish opens as is: «;», BOM, formulas as text. */
export function statisticsCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): string {
  return `${BOM}${[header, ...rows].map((row) => row.map(csvCell).join(CSV_SEPARATOR)).join("\r\n")}\r\n`;
}

/** One row per day, page or place, scene and action (from the per-day data). */
export function visitsCsv(data: VisitStatisticsData): string {
  const rows = [...data.items]
    .filter((item) => item.day !== null)
    .sort(
      (a, b) =>
        (a.day ?? "").localeCompare(b.day ?? "") ||
        a.target.localeCompare(b.target) ||
        (a.title ?? "").localeCompare(b.title ?? "", "es") ||
        a.event.localeCompare(b.event),
    )
    .map((item) => [
      item.day,
      VISIT_TARGET_LABELS[item.target],
      item.contentId ? (item.title ?? UNNAMED) : null,
      item.slug,
      item.sceneId ? (item.sceneTitle ?? "(tour borrado)") : null,
      VISIT_EVENT_LABELS[item.event],
      item.views,
      item.visitors,
    ]);
  return statisticsCsv(
    ["fecha", "página", "lugar", "dirección", "escena", "acción", "veces", "visitantes"],
    rows,
  );
}

/** One row per day, country and city (page views only). */
export function originsCsv(data: VisitStatisticsData): string {
  const rows = [...data.origins]
    .filter((origin) => origin.day !== null)
    .sort(
      (a, b) =>
        (a.day ?? "").localeCompare(b.day ?? "") ||
        b.views - a.views ||
        (a.country ?? "~").localeCompare(b.country ?? "~") ||
        (a.city ?? "~").localeCompare(b.city ?? "~"),
    )
    .map((origin) => [origin.day, origin.country, origin.city, origin.views, origin.visitors]);
  return statisticsCsv(["fecha", "país", "ciudad", "vistas", "visitantes"], rows);
}

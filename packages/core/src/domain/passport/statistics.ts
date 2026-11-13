import {
  measure,
  statisticsCsv,
  type DateRange,
  type Measure,
  type StatisticsRange,
} from "../visits/statistics";

/**
 * The tourist passport in «Estadísticas» and the monthly report (C2 · Paso 4, ADR-059).
 *
 * Stamps: how many phones stamped each place in a day (once per phone, place and day) and, of
 * those, how many with the phone saying it was there — the «visitas comprobadas en el lugar».
 * Circuits: how many phones completed each one (got a voucher) and how many prizes were
 * redeemed. Nothing here identifies a visitor.
 */

// ── What the database returns ───────────────────────────────────────────────

export interface PassportPlaceRow {
  /** Only when asked per day. */
  readonly day: string | null;
  readonly contentId: string;
  readonly slug: string | null;
  readonly title: string | null;
  /** A phone can stamp it now (a published stop of a published circuit). */
  readonly stop: boolean;
  readonly stamps: number;
  readonly located: number;
}

export interface PassportCircuitRow {
  readonly day: string | null;
  readonly circuitId: string;
  readonly slug: string;
  readonly name: string;
  readonly published: boolean;
  /** Phones that completed it (got a voucher) in the period. */
  readonly completed: number;
  /** Prizes handed over in the period. */
  readonly redeemed: number;
}

export interface PassportStatisticsData extends DateRange {
  /** The first day a stamp was counted (null: none yet). */
  readonly since: string | null;
  readonly places: readonly PassportPlaceRow[];
  readonly circuits: readonly PassportCircuitRow[];
}

// ── The summary ─────────────────────────────────────────────────────────────

export const PASSPORT_TOTALS = ["stamps", "located", "completed", "redeemed"] as const;
export type PassportTotal = (typeof PASSPORT_TOTALS)[number];

export interface PassportPlaceStatistics {
  readonly contentId: string;
  readonly slug: string | null;
  readonly title: string;
  readonly stop: boolean;
  /** Views of its page in the portal in the period (from the visit counts). */
  readonly views: number;
  readonly stamps: number;
  readonly located: number;
}

export interface PassportCircuitStatistics {
  readonly circuitId: string;
  readonly slug: string;
  readonly name: string;
  readonly published: boolean;
  readonly completed: number;
  readonly redeemed: number;
}

export interface PassportSummary {
  /** False when the previous period starts before the first counted stamp. */
  readonly compared: boolean;
  readonly since: string | null;
  readonly totals: Readonly<Record<PassportTotal, Measure>>;
  /** Most stamped first; every place a phone can stamp now, zeros included. */
  readonly places: readonly PassportPlaceStatistics[];
  readonly circuits: readonly PassportCircuitStatistics[];
  /** The municipality has a published circuit, or something was counted in the period. */
  readonly active: boolean;
  /** Nothing was stamped nor completed in the period. */
  readonly empty: boolean;
}

const UNNAMED = "(sin nombre)";

function totalsOf(data: PassportStatisticsData): Record<PassportTotal, number> {
  return {
    stamps: data.places.reduce((total, place) => total + place.stamps, 0),
    located: data.places.reduce((total, place) => total + place.located, 0),
    completed: data.circuits.reduce((total, circuit) => total + circuit.completed, 0),
    redeemed: data.circuits.reduce((total, circuit) => total + circuit.redeemed, 0),
  };
}

function placesOf(
  rows: readonly PassportPlaceRow[],
  views: ReadonlyMap<string, number>,
): PassportPlaceStatistics[] {
  const places = new Map<string, PassportPlaceStatistics>();
  for (const row of rows) {
    const place = places.get(row.contentId) ?? {
      contentId: row.contentId,
      slug: row.slug,
      title: row.title ?? UNNAMED,
      stop: row.stop,
      views: views.get(row.contentId) ?? 0,
      stamps: 0,
      located: 0,
    };
    places.set(row.contentId, {
      ...place,
      stop: place.stop || row.stop,
      stamps: place.stamps + row.stamps,
      located: place.located + row.located,
    });
  }
  return [...places.values()].sort(
    (a, b) => b.stamps - a.stamps || b.located - a.located || a.title.localeCompare(b.title, "es"),
  );
}

function circuitsOf(rows: readonly PassportCircuitRow[]): PassportCircuitStatistics[] {
  const circuits = new Map<string, PassportCircuitStatistics>();
  for (const row of rows) {
    const circuit = circuits.get(row.circuitId) ?? {
      circuitId: row.circuitId,
      slug: row.slug,
      name: row.name,
      published: row.published,
      completed: 0,
      redeemed: 0,
    };
    circuits.set(row.circuitId, {
      ...circuit,
      completed: circuit.completed + row.completed,
      redeemed: circuit.redeemed + row.redeemed,
    });
  }
  return [...circuits.values()].sort(
    (a, b) =>
      Number(b.published) - Number(a.published) ||
      b.completed - a.completed ||
      a.name.localeCompare(b.name, "es"),
  );
}

/**
 * The passport's numbers of a period and, when the previous period was counted entirely (it
 * starts on or after the first counted stamp), how they changed. `views`: the views of each
 * place's page in the same period (content id → views), to show them side by side.
 */
export function summarizePassport(
  range: StatisticsRange,
  current: PassportStatisticsData,
  previous: PassportStatisticsData | null,
  views: ReadonlyMap<string, number> = new Map(),
): PassportSummary {
  const compared =
    previous !== null && current.since !== null && range.previous.from >= current.since;
  const now = totalsOf(current);
  const before = compared && previous ? totalsOf(previous) : null;
  const totals = Object.fromEntries(
    PASSPORT_TOTALS.map((key) => [key, measure(now[key], before ? before[key] : null)]),
  ) as Record<PassportTotal, Measure>;
  return {
    compared,
    since: current.since,
    totals,
    places: placesOf(current.places, views),
    circuits: circuitsOf(current.circuits),
    active: current.places.length > 0 || current.circuits.some((circuit) => circuit.published),
    empty: now.stamps === 0 && now.completed === 0 && now.redeemed === 0,
  };
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** One row per day and place (stamps) or circuit (completed, redeemed), from per-day data. */
export function passportCsv(data: PassportStatisticsData): string {
  const places = data.places
    .filter((row) => row.day !== null)
    .map((row) => [
      row.day,
      "Sellos de un lugar",
      row.title ?? UNNAMED,
      row.slug,
      row.stamps,
      row.located,
      null,
      null,
    ]);
  const circuits = data.circuits
    .filter((row) => row.day !== null)
    .map((row) => [
      row.day,
      "Circuito",
      row.name,
      row.slug,
      null,
      null,
      row.completed,
      row.redeemed,
    ]);
  const rows = [...places, ...circuits].sort(
    (a, b) =>
      String(a[0]).localeCompare(String(b[0])) ||
      String(a[1]).localeCompare(String(b[1])) ||
      String(a[2]).localeCompare(String(b[2]), "es"),
  );
  return statisticsCsv(
    [
      "fecha",
      "tipo",
      "nombre",
      "dirección",
      "sellos",
      "sellos con ubicación",
      "circuitos completados",
      "premios canjeados",
    ],
    rows,
  );
}

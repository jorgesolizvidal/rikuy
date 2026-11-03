import { formatClockTime, MINUTES_PER_DAY, parseClockTime, type LocalClock } from "./clock";

/**
 * Opening hours of a destination (ADR-039), in the municipality's local time. Mirrors
 * `private.is_valid_opening_hours`: days start on Monday, up to two ranges a day, a range
 * opens before it closes within the day ("24:00" closes at midnight). No overnight ranges.
 * Without hours (null) a place is «sin horario publicado»: plans keep it, with a warning.
 */

export type OpeningRange = readonly [open: string, close: string];

export type OpeningHours =
  | { readonly mode: "always"; readonly note: string }
  | {
      readonly mode: "weekly";
      readonly days: readonly (readonly OpeningRange[])[];
      readonly note: string;
    };

export const OPENING_HOURS_LIMITS = { note: 120, rangesPerDay: 2, days: 7 } as const;

/** Ranges of one weekday as minutes, [open, close) — malformed ranges are dropped. */
export function dayRanges(hours: OpeningHours, weekday: number): [number, number][] {
  if (hours.mode === "always") return [[0, MINUTES_PER_DAY]];
  const ranges: [number, number][] = [];
  for (const [open, close] of hours.days[weekday] ?? []) {
    const from = parseClockTime(open);
    const to = parseClockTime(close);
    if (from !== null && to !== null && from < to) ranges.push([from, to]);
  }
  return ranges;
}

export type OpenState =
  | { readonly state: "unknown" }
  | { readonly state: "always" }
  | { readonly state: "open"; readonly closesAt: number }
  | {
      readonly state: "closed";
      /** The next opening: days from today (0 = later today) and the local time. */
      readonly opens: {
        readonly inDays: number;
        readonly weekday: number;
        readonly at: number;
      } | null;
    };

/** Open or closed at a local moment (minutes may go past midnight: they roll to the next day). */
export function openStateAt(hours: OpeningHours | null, clock: LocalClock): OpenState {
  if (hours === null) return { state: "unknown" };
  if (hours.mode === "always") return { state: "always" };
  const shift = Math.floor(clock.minutes / MINUTES_PER_DAY);
  const weekday = (((clock.weekday + shift) % 7) + 7) % 7;
  const minutes = clock.minutes - shift * MINUTES_PER_DAY;
  for (const [open, close] of dayRanges(hours, weekday)) {
    if (minutes >= open && minutes < close) {
      // A range closing at midnight that the next day opens at 00:00 keeps it open.
      const next = dayRanges(hours, (weekday + 1) % 7)[0];
      return {
        state: "open",
        closesAt: close === MINUTES_PER_DAY && next?.[0] === 0 ? MINUTES_PER_DAY + next[1] : close,
      };
    }
  }
  for (let inDays = 0; inDays <= 7; inDays += 1) {
    const day = (weekday + inDays) % 7;
    const upcoming = dayRanges(hours, day).find(([open]) => inDays > 0 || open > minutes);
    if (upcoming) return { state: "closed", opens: { inDays, weekday: day, at: upcoming[0] } };
  }
  return { state: "closed", opens: null };
}

/** Open at every minute of [from, to) (local minutes of the same day as `clock`). */
export function isOpenThrough(
  hours: OpeningHours | null,
  clock: LocalClock,
  from: number,
  to: number,
): boolean {
  if (hours === null || hours.mode === "always") return true;
  const at = openStateAt(hours, { ...clock, minutes: from });
  return at.state === "open" && at.closesAt >= to;
}

/** When a place open at `from` closes (local minutes of the same day); Infinity when never. */
export function closingAfter(hours: OpeningHours | null, clock: LocalClock, from: number): number {
  if (hours === null || hours.mode === "always") return Number.POSITIVE_INFINITY;
  const at = openStateAt(hours, { ...clock, minutes: from });
  return at.state === "open" ? from - (from % MINUTES_PER_DAY) + at.closesAt : from;
}

// ── In words ───────────────────────────────────────────────────────────────

export type HoursLanguage = "es" | "en";

const DAY_NAMES: Record<HoursLanguage, readonly string[]> = {
  es: ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"],
  en: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
};

export function weekdayName(weekday: number, lang: HoursLanguage = "es"): string {
  return DAY_NAMES[lang][weekday] ?? "";
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase("es") + text.slice(1);
}

function rangesText(ranges: [number, number][], lang: HoursLanguage): string {
  if (ranges.length === 0) return lang === "en" ? "closed" : "cerrado";
  return ranges
    .map(([open, close]) => `${formatClockTime(open)}–${formatClockTime(close)}`)
    .join(lang === "en" ? " and " : " y ");
}

export interface HoursLine {
  /** «Lunes a viernes», «Sábado», «Todos los días». */
  readonly days: string;
  /** «9:00–12:30 y 14:00–18:00», «cerrado». */
  readonly times: string;
}

/** The week in lines, consecutive days with the same hours together. */
export function openingHoursLines(hours: OpeningHours, lang: HoursLanguage = "es"): HoursLine[] {
  if (hours.mode === "always") {
    return [
      {
        days: lang === "en" ? "Every day" : "Todos los días",
        times: lang === "en" ? "open 24 hours" : "abierto las 24 horas",
      },
    ];
  }
  const texts = Array.from({ length: 7 }, (_, day) => rangesText(dayRanges(hours, day), lang));
  if (texts.every((text) => text === texts[0])) {
    return [{ days: lang === "en" ? "Every day" : "Todos los días", times: texts[0] ?? "" }];
  }
  const lines: HoursLine[] = [];
  let start = 0;
  for (let day = 1; day <= 7; day += 1) {
    if (day < 7 && texts[day] === texts[start]) continue;
    const end = day - 1;
    const first = weekdayName(start, lang);
    const last = weekdayName(end, lang);
    const days =
      start === end
        ? first
        : end === start + 1
          ? `${first} ${lang === "en" ? "and" : "y"} ${last}`
          : `${first} ${lang === "en" ? "to" : "a"} ${last}`;
    lines.push({ days: capitalize(days), times: texts[start] ?? "" });
    start = day;
  }
  return lines;
}

/** One line: «Lunes a viernes: 9:00–18:00; sábado: 10:00–14:00; domingo: cerrado». */
export function openingHoursText(hours: OpeningHours, lang: HoursLanguage = "es"): string {
  const lines = openingHoursLines(hours, lang).map(
    (line, index) =>
      `${index === 0 ? line.days : line.days.toLocaleLowerCase("es")}: ${line.times}`,
  );
  const note = hours.note.trim();
  return `${lines.join("; ")}${note ? `. ${note}` : ""}`;
}

/** «Abierto ahora · cierra a las 18:00», «Cerrado · abre mañana a las 9:00». */
export function describeOpenState(state: OpenState, lang: HoursLanguage = "es"): string | null {
  const en = lang === "en";
  switch (state.state) {
    case "unknown":
      return null;
    case "always":
      return en ? "Open now · always open" : "Abierto ahora · abierto siempre";
    case "open":
      return state.closesAt > MINUTES_PER_DAY
        ? en
          ? `Open now · closes tomorrow at ${formatClockTime(state.closesAt - MINUTES_PER_DAY)}`
          : `Abierto ahora · cierra mañana a las ${formatClockTime(state.closesAt - MINUTES_PER_DAY)}`
        : en
          ? `Open now · closes at ${formatClockTime(state.closesAt)}`
          : `Abierto ahora · cierra a las ${formatClockTime(state.closesAt)}`;
    case "closed": {
      if (!state.opens) return en ? "Closed" : "Cerrado";
      const at = formatClockTime(state.opens.at);
      if (state.opens.inDays === 0) {
        return en ? `Closed now · opens at ${at}` : `Cerrado ahora · abre a las ${at}`;
      }
      if (state.opens.inDays === 1) {
        return en
          ? `Closed now · opens tomorrow at ${at}`
          : `Cerrado ahora · abre mañana a las ${at}`;
      }
      const day = weekdayName(state.opens.weekday, lang);
      return en
        ? `Closed now · opens ${day} at ${at}`
        : `Cerrado ahora · abre el ${day} a las ${at}`;
    }
  }
}

import { localTimeValue, type EventSchedule } from "../../contracts/event";

/**
 * Human dates for events, from their LOCAL schedule (never converted through the
 * visitor's or the server's time zone: "19:00" is 19:00 in the municipality).
 * Local values are formatted on a UTC timeline, so the output is the same everywhere.
 */

const DAY_MS = 86_400_000;

function bounds(schedule: EventSchedule): { start: Date; end: Date } {
  const start = localTimeValue(schedule.start, schedule.allDay);
  const end = localTimeValue(schedule.end, schedule.allDay);
  if (start === null || end === null) throw new Error("Invalid event schedule");
  return { start: new Date(start), end: new Date(end) };
}

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

/** ICU puts thin spaces around range dashes; plain spaces read the same everywhere. */
const plainSpaces = (text: string) => text.replace(/[\u2009\u202f]/gu, " ");

/**
 * "Sábado, 2 de noviembre de 2026, 19:00–22:00", "2–4 de noviembre de 2026",
 * "Domingo, 8 de noviembre de 2026 (todo el día)".
 */
export function formatEventSchedule(schedule: EventSchedule, locale = "es"): string {
  const { start, end } = bounds(schedule);
  const sameDay = schedule.start.slice(0, 10) === schedule.end.slice(0, 10);
  if (schedule.allDay) {
    if (sameDay) {
      const day = new Intl.DateTimeFormat(locale, {
        timeZone: "UTC",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(start);
      return `${capitalize(day)} (todo el día)`;
    }
    return plainSpaces(
      new Intl.DateTimeFormat(locale, {
        timeZone: "UTC",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).formatRange(start, end),
    );
  }
  const format = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    ...(sameDay ? { weekday: "long" as const } : {}),
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return capitalize(
    plainSpaces(
      start.getTime() === end.getTime() ? format.format(start) : format.formatRange(start, end),
    ),
  );
}

/** Badge for cards: { day: "2", month: "nov" } of the first day. */
export function eventDateBadge(
  schedule: EventSchedule,
  locale = "es",
): { day: string; month: string } {
  const { start } = bounds(schedule);
  return {
    day: String(start.getUTCDate()),
    month: new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short" })
      .format(start)
      .replace(".", ""),
  };
}

/** "2026-11" — events are grouped by the month they start in. */
export function eventMonthKey(schedule: EventSchedule): string {
  return schedule.start.slice(0, 7);
}

/** "Noviembre de 2026". */
export function formatEventMonth(monthKey: string, locale = "es"): string {
  const [year, month] = monthKey.split("-").map(Number);
  return capitalize(
    new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", year: "numeric" }).format(
      new Date(Date.UTC(year ?? 2000, (month ?? 1) - 1, 1)),
    ),
  );
}

/** The day after the last day of an all-day event, as YYYYMMDD (iCalendar DTEND). */
export function dayAfter(date: string): string {
  const value = localTimeValue(date, true);
  if (value === null) throw new Error("Invalid date");
  return new Date(value + DAY_MS).toISOString().slice(0, 10).replaceAll("-", "");
}

/** Groups items by start month, keeping their order (they arrive sorted by start). */
export function groupByMonth<T extends { readonly schedule: EventSchedule }>(
  items: readonly T[],
): { monthKey: string; items: T[] }[] {
  const groups: { monthKey: string; items: T[] }[] = [];
  for (const item of items) {
    const key = eventMonthKey(item.schedule);
    const last = groups.at(-1);
    if (last && last.monthKey === key) last.items.push(item);
    else groups.push({ monthKey: key, items: [item] });
  }
  return groups;
}

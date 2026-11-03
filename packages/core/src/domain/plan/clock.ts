/**
 * The municipality's local clock (tenants.timezone). Opening hours, «hoy» and the times of a
 * plan are all in local time; instants (events) are converted with the same zone.
 */

export const MINUTES_PER_DAY = 24 * 60;

export interface LocalClock {
  /** Monday = 0 … Sunday = 6 (the order of OpeningHours.days). */
  readonly weekday: number;
  /** Minutes since local midnight. */
  readonly minutes: number;
  /** Local date, YYYY-MM-DD. */
  readonly date: string;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function formatter(timezone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return formatter("UTC");
  }
}

export function localClock(at: Date, timezone: string): LocalClock {
  const parts: Record<string, string> = {};
  for (const part of formatter(timezone).formatToParts(at)) parts[part.type] = part.value;
  const hour = Number(parts.hour) % 24;
  return {
    weekday: Math.max(0, WEEKDAYS.indexOf(parts.weekday ?? "Mon")),
    minutes: hour * 60 + Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

/**
 * An instant as minutes from the local midnight that starts `day` (negative before it,
 * beyond MINUTES_PER_DAY after it).
 */
export function minutesFromDayStart(instant: Date, day: LocalClock, timezone: string): number {
  const local = localClock(instant, timezone);
  return (dayNumber(local.date) - dayNumber(day.date)) * MINUTES_PER_DAY + local.minutes;
}

/** "HH:MM" → minutes (24:00 → 1440); null when malformed. */
export function parseClockTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes <= MINUTES_PER_DAY && Number(match[2]) < 60 ? minutes : null;
}

/** 545 → "9:05"; 1440 → "24:00". */
export function formatClockTime(minutes: number): string {
  const whole = Math.round(minutes);
  const hours = Math.floor(whole / 60);
  return `${hours}:${String(whole % 60).padStart(2, "0")}`;
}

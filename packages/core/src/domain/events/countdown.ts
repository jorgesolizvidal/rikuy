import { localClock } from "../plan/clock";

/**
 * How far an event is, for its page (C3 · Paso 4, ADR-063): «Hoy a las 19:00», «Mañana»,
 * «En 5 días», «En curso» or «Ya terminó». The page is cached, so the browser computes it with
 * the municipality's clock (never the visitor's time zone): «hoy» is the municipality's today.
 * No schemas here: browser code imports it from `@rikuy/core/geo`.
 */

export type EventCountdown =
  | { readonly state: "ended" }
  | { readonly state: "ongoing" }
  | { readonly state: "today"; readonly time: string | null }
  | { readonly state: "tomorrow"; readonly time: string | null }
  | { readonly state: "soon"; readonly days: number }
  | { readonly state: "later" };

/** Beyond this many days the date block says enough. */
export const COUNTDOWN_DAYS = 30;

export interface CountdownEvent {
  /** The local schedule: `YYYY-MM-DD` (all day) or `YYYY-MM-DDTHH:MM`. */
  readonly schedule: { readonly allDay: boolean; readonly start: string };
  /** Instants (ISO 8601) computed with the municipality's time zone. */
  readonly startsAt: string;
  readonly endsAt: string;
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

export function eventCountdown(event: CountdownEvent, now: Date, timezone: string): EventCountdown {
  const at = now.getTime();
  const starts = Date.parse(event.startsAt);
  const ends = Date.parse(event.endsAt);
  if (Number.isFinite(ends) && at >= ends) return { state: "ended" };
  if (Number.isFinite(starts) && at >= starts) return { state: "ongoing" };
  const startDate = event.schedule.start.slice(0, 10);
  const days = dayNumber(startDate) - dayNumber(localClock(now, timezone).date);
  const time = event.schedule.allDay ? null : event.schedule.start.slice(11, 16) || null;
  if (days <= 0) return { state: "today", time };
  if (days === 1) return { state: "tomorrow", time };
  if (days <= COUNTDOWN_DAYS) return { state: "soon", days };
  return { state: "later" };
}

/** The words of a countdown; null when the date says enough. */
export function describeCountdown(countdown: EventCountdown): string | null {
  switch (countdown.state) {
    case "ended":
      return "Ya terminó";
    case "ongoing":
      return "En curso";
    case "today":
      return countdown.time ? `Hoy a las ${countdown.time}` : "Hoy";
    case "tomorrow":
      return countdown.time ? `Mañana a las ${countdown.time}` : "Mañana";
    case "soon":
      return `En ${String(countdown.days)} días`;
    case "later":
      return null;
  }
}

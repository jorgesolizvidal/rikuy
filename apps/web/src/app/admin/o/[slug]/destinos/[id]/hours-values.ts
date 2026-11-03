import type { OpeningHours } from "@rikuy/core";

/**
 * The opening hours as the editor holds them (ADR-039), and back. Server and client code
 * both use these (the page builds the initial values; the form saves them).
 */

export interface HoursRange {
  readonly from: string;
  readonly to: string;
}

export interface DayValues {
  readonly open: boolean;
  readonly ranges: readonly HoursRange[];
}

export interface HoursValues {
  readonly mode: "none" | "always" | "weekly";
  readonly days: readonly DayValues[];
  readonly note: string;
}

const DEFAULT_RANGE: HoursRange = { from: "09:00", to: "17:00" };

export function toHoursValues(hours: OpeningHours | null | undefined): HoursValues {
  // Choosing «Por días» starts from every day 9:00–17:00, to adjust.
  const week = Array.from({ length: 7 }, () => ({ open: true, ranges: [DEFAULT_RANGE] }));
  if (!hours) return { mode: "none", days: week, note: "" };
  if (hours.mode === "always") return { mode: "always", days: week, note: hours.note };
  return {
    mode: "weekly",
    days: Array.from({ length: 7 }, (_, day) => {
      const ranges = hours.days[day] ?? [];
      return ranges.length === 0
        ? { open: false, ranges: [DEFAULT_RANGE] }
        : {
            open: true,
            // Midnight is written 00:00 in a time field (24:00 does not exist there).
            ranges: ranges.map(([from, to]) => ({ from, to: to === "24:00" ? "00:00" : to })),
          };
    }),
    note: hours.note,
  };
}

/** What is saved: null without hours; the server validates the rest. */
export function fromHoursValues(values: HoursValues): OpeningHours | null {
  const note = values.note.trim();
  if (values.mode === "none") return null;
  if (values.mode === "always") return { mode: "always", note };
  return {
    mode: "weekly",
    days: values.days.map((day) =>
      day.open
        ? day.ranges.map(
            (range) => [range.from, range.to === "00:00" ? "24:00" : range.to] as const,
          )
        : [],
    ),
    note,
  };
}

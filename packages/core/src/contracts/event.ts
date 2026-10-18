import { z } from "zod";

import {
  destinationDocumentSchema,
  type DestinationDocument,
  type DestinationIssue,
  type ImageReference,
} from "./destination";

/**
 * Editable document of an event (one revision): the destination fields plus a schedule
 * and an optional venue (a destination of the same municipality). Mirrors
 * `private.is_valid_event_draft`.
 *
 * The schedule is LOCAL wall-clock time of the municipality, exactly as organizers write
 * it: `2026-11-02T19:00` (timed) or `2026-11-02` (all day; the end day is inclusive).
 * The database turns it into instants with the tenant's time zone.
 */

export const EVENT_LIMITS = {
  /** An event lasts at most this many days (end − start). */
  maxDays: 366,
  minYear: 2000,
  maxYear: 2100,
} as const;

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DAY_MS = 86_400_000;

/**
 * Milliseconds of a local date (or date-time) read as if it were UTC — a timeline that
 * only serves to compare and format local values — or null if the value does not exist
 * (30 February, 24:00, wrong format for the kind of event).
 */
export function localTimeValue(value: string, allDay: boolean): number | null {
  const match = (allDay ? LOCAL_DATE : LOCAL_DATE_TIME).exec(value);
  if (!match) return null;
  const [, y, m, d, hh = "0", mm = "0"] = match;
  const [year, month, day, hour, minute] = [y, m, d, hh, mm].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (hour > 23 || minute > 59) return null;
  const time = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(time);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1) return null;
  if (check.getUTCDate() !== day) return null;
  return time;
}

export const eventScheduleSchema = z
  .strictObject({ allDay: z.boolean(), start: z.string().max(16), end: z.string().max(16) })
  .superRefine((schedule, context) => {
    const start = localTimeValue(schedule.start, schedule.allDay);
    const end = localTimeValue(schedule.end, schedule.allDay);
    if (start === null) context.addIssue({ code: "custom", path: ["start"], message: "invalid" });
    if (end === null) context.addIssue({ code: "custom", path: ["end"], message: "invalid" });
    if (start === null || end === null) return;
    const year = new Date(start).getUTCFullYear();
    if (year < EVENT_LIMITS.minYear || year > EVENT_LIMITS.maxYear) {
      context.addIssue({ code: "custom", path: ["start"], message: "invalid" });
    }
    if (end < start) context.addIssue({ code: "custom", path: ["end"], message: "order" });
    else if (end - start > EVENT_LIMITS.maxDays * DAY_MS) {
      context.addIssue({ code: "custom", path: ["end"], message: "invalid" });
    }
  });
export type EventSchedule = z.infer<typeof eventScheduleSchema>;

export const eventDocumentSchema = destinationDocumentSchema.extend({
  schedule: eventScheduleSchema.nullable(),
  venueId: z.string().regex(UUID).nullable(),
});
export type EventDocument = z.infer<typeof eventDocumentSchema>;

export type EventValidation =
  | { readonly ok: true; readonly value: EventDocument }
  | { readonly ok: false; readonly issues: readonly DestinationIssue[] };

export function validateEventDocument(input: unknown): EventValidation {
  const parsed = eventDocumentSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      code: issue.message === "order" ? ("order" as const) : ("invalid" as const),
    })),
  };
}

/** What an event draft still needs before visitors can see it. */
export function eventPublicationIssues(document: EventDocument): DestinationIssue[] {
  const issues: DestinationIssue[] = [];
  if (document.summary === "") issues.push({ path: "summary", code: "required" });
  if (document.schedule === null) issues.push({ path: "schedule", code: "required" });
  if (document.location === null) issues.push({ path: "location", code: "required" });
  return issues;
}

export function eventImages(document: EventDocument): ImageReference[] {
  return [...(document.cover ? [document.cover] : []), ...document.gallery];
}

export function emptyEventDocument(title: string): EventDocument {
  const base: DestinationDocument = {
    title,
    summary: "",
    body: [],
    location: null,
    cover: null,
    gallery: [],
  };
  return { ...base, schedule: null, venueId: null };
}

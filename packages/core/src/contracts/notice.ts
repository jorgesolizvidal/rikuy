import { z } from "zod";

import { localTimeValue } from "./event";
import { richTextSchema } from "./rich-text";

/**
 * A notice of the municipality (ADR-069): a road cut, a fair called off, a change of hours.
 * The editor writes its validity in the municipality's LOCAL time, like events
 * (`2026-12-01T08:00`); the database turns it into instants with the tenant's time zone.
 * Mirrors `private.is_valid_notice_draft` and `private.parse_notice_validity`.
 */

export const NOTICE_LIMITS = {
  title: 120,
  summary: 300,
  /** «Hasta» is at most this many days after the notice starts to count. */
  maxDays: 90,
  minYear: 2000,
  maxYear: 2100,
} as const;

const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const line = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);

const localMinute = z.string().max(16).nullable();

/** «Desde» (optional) and «hasta» (required to publish), local minutes. */
export const noticeValiditySchema = z
  .strictObject({ from: localMinute, until: localMinute })
  .superRefine((validity, context) => {
    const check = (key: "from" | "until") => {
      const value = validity[key];
      if (value === null) return null;
      const time = localTimeValue(value, false);
      const year = time === null ? null : new Date(time).getUTCFullYear();
      if (
        time === null ||
        year === null ||
        year < NOTICE_LIMITS.minYear ||
        year > NOTICE_LIMITS.maxYear
      ) {
        context.addIssue({ code: "custom", path: [key], message: "invalid" });
        return null;
      }
      return time;
    };
    const from = check("from");
    const until = check("until");
    if (from === null || until === null) return;
    if (until <= from) context.addIssue({ code: "custom", path: ["until"], message: "order" });
    else if (until - from > NOTICE_LIMITS.maxDays * DAY_MS) {
      context.addIssue({ code: "custom", path: ["until"], message: "too_long" });
    }
  });

export type NoticeValidity = z.infer<typeof noticeValiditySchema>;

export const noticeDocumentSchema = z.strictObject({
  title: line(1, NOTICE_LIMITS.title),
  /** The notice's text: what the strip and the place's page show. */
  summary: line(0, NOTICE_LIMITS.summary),
  /** Optional details, on `/avisos`. */
  body: richTextSchema,
  validity: noticeValiditySchema,
  /** A destination or an event of the same municipality, or none. */
  placeId: z.string().regex(UUID).nullable(),
});

export type NoticeDocument = z.infer<typeof noticeDocumentSchema>;

/**
 * Why a notice cannot be saved or published: `order` «hasta» before «desde»; `too_long` more
 * than 90 days; `past` its end already came; `place` not a destination or event of this
 * municipality.
 */
export type NoticeIssueCode = "invalid" | "required" | "order" | "too_long" | "past" | "place";

export interface NoticeIssue {
  readonly path: string;
  readonly code: NoticeIssueCode;
}

export type NoticeValidation =
  | { readonly ok: true; readonly value: NoticeDocument }
  | { readonly ok: false; readonly issues: readonly NoticeIssue[] };

export function validateNoticeDocument(input: unknown): NoticeValidation {
  const parsed = noticeDocumentSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      code:
        issue.message === "order"
          ? ("order" as const)
          : issue.message === "too_long"
            ? ("too_long" as const)
            : ("invalid" as const),
    })),
  };
}

export function emptyNoticeDocument(title: string): NoticeDocument {
  return {
    title,
    summary: "",
    body: [],
    validity: { from: null, until: null },
    placeId: null,
  };
}

/** Where the visitor sees a notice: in force now, and its place (when published). */
export interface PublishedNotice {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly body: z.infer<typeof richTextSchema>;
  /** Instants (ISO 8601) with the municipality's time zone; no start = in force once published. */
  readonly startsAt: string | null;
  readonly endsAt: string;
  readonly place: {
    readonly kind: "destination" | "event";
    readonly slug: string;
    readonly title: string;
  } | null;
}

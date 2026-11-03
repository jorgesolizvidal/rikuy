import { z } from "zod";

import { OPENING_HOURS_LIMITS } from "../domain/plan/hours";
import { richTextSchema, type RichText } from "./rich-text";

/**
 * Editable document of a destination (one revision). Mirrors
 * `private.is_valid_destination_draft`. Images are referenced by asset version, never by
 * URL, and always carry alternative text.
 */

export const DESTINATION_LIMITS = {
  title: 120,
  summary: 300,
  alt: 200,
  gallery: 30,
  slug: 80,
} as const;

/** Content identifiers: lowercase words joined by single hyphens. */
export const CONTENT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function isValidContentSlug(value: string): boolean {
  return value.length <= DESTINATION_LIMITS.slug && CONTENT_SLUG_PATTERN.test(value);
}

const NO_CONTROL_CHARACTERS = /^[^\p{Cc}]*$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const line = (min: number, max: number) =>
  z.string().trim().min(min).max(max).regex(NO_CONTROL_CHARACTERS);

export const imageReferenceSchema = z.strictObject({
  assetId: z.string().regex(UUID),
  version: z.number().int().min(1).max(999_999),
  alt: line(1, DESTINATION_LIMITS.alt),
});
export type ImageReference = z.infer<typeof imageReferenceSchema>;

export const geoPointSchema = z.strictObject({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof geoPointSchema>;

const OPEN_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const CLOSE_TIME = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/u;

/** Opening hours (ADR-039); mirrors `private.is_valid_opening_hours`. */
export const openingHoursSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("always"),
    note: line(0, OPENING_HOURS_LIMITS.note),
  }),
  z
    .strictObject({
      mode: z.literal("weekly"),
      days: z
        .array(
          z
            .array(z.tuple([z.string().regex(OPEN_TIME), z.string().regex(CLOSE_TIME)]))
            .max(OPENING_HOURS_LIMITS.rangesPerDay),
        )
        .length(OPENING_HOURS_LIMITS.days),
      note: line(0, OPENING_HOURS_LIMITS.note),
    })
    .superRefine((hours, context) => {
      let ranges = 0;
      hours.days.forEach((day, index) => {
        let previous: string | null = null;
        for (const [open, close] of day) {
          // "HH:MM" strings compare as times.
          if (open >= close || (previous !== null && open <= previous)) {
            context.addIssue({ code: "custom", path: ["days", index], message: "order" });
          }
          previous = close;
          ranges += 1;
        }
      });
      if (ranges === 0) context.addIssue({ code: "custom", path: ["days"], message: "required" });
    }),
]);

export const destinationDocumentSchema = z.strictObject({
  title: line(1, DESTINATION_LIMITS.title),
  summary: line(0, DESTINATION_LIMITS.summary),
  body: richTextSchema,
  location: geoPointSchema.nullable(),
  cover: imageReferenceSchema.nullable(),
  gallery: z.array(imageReferenceSchema).max(DESTINATION_LIMITS.gallery),
  /** Optional: without it (or null) the place has no published hours. */
  hours: openingHoursSchema.nullable().optional(),
});
export type DestinationDocument = z.infer<typeof destinationDocumentSchema>;

/** `order`: the end of an event is before its start. */
export type DestinationIssueCode = "invalid" | "required" | "media" | "order";

export interface DestinationIssue {
  /** Dot path, e.g. `title`, `location`, `gallery.2.alt`. */
  readonly path: string;
  readonly code: DestinationIssueCode;
}

export type DestinationValidation =
  | { readonly ok: true; readonly value: DestinationDocument }
  | { readonly ok: false; readonly issues: readonly DestinationIssue[] };

export function validateDestinationDocument(input: unknown): DestinationValidation {
  const parsed = destinationDocumentSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      code: "invalid" as const,
    })),
  };
}

/** What a draft still needs before it can be published (visitors need both). */
export function publicationIssues(document: DestinationDocument): DestinationIssue[] {
  const issues: DestinationIssue[] = [];
  if (document.summary === "") issues.push({ path: "summary", code: "required" });
  if (document.location === null) issues.push({ path: "location", code: "required" });
  return issues;
}

/** Every image referenced by the document (cover first). */
export function documentImages(document: DestinationDocument): ImageReference[] {
  return [...(document.cover ? [document.cover] : []), ...document.gallery];
}

export function emptyDestinationDocument(title: string): DestinationDocument {
  const body: RichText = [];
  return { title, summary: "", body, location: null, cover: null, gallery: [] };
}

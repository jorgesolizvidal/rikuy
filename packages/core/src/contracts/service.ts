import { z } from "zod";

import type { OpeningHours } from "../domain/plan/hours";
import { geoPointSchema, openingHoursSchema } from "./destination";

/**
 * A local service of the municipality (ADR-069): where to eat, sleep, take out cash, catch
 * transport or fill up the tank. A category of the platform's fixed list, a short description,
 * the opening hours of destinations (ADR-039), a phone and a WhatsApp number, an address in
 * words and, optionally, its place on the map. Mirrors `private.is_valid_service_draft`.
 */

export const SERVICE_CATEGORIES = [
  "food",
  "lodging",
  "cash",
  "transport",
  "fuel",
  "health",
  "tourist_info",
  "other",
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export const SERVICE_LIMITS = {
  title: 120,
  summary: 300,
  address: 160,
} as const;

const NO_CONTROL_CHARACTERS = /^[^\p{Cc}]*$/u;

const line = (min: number, max: number) =>
  z.string().trim().min(min).max(max).regex(NO_CONTROL_CHARACTERS);

/** A number as people write it: digits, spaces, parentheses and dashes (`4 4441234`). */
export const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{5,22}$/u;
/** WhatsApp needs the country code (`+591 70000000`) to make a wa.me link. */
export const WHATSAPP_PATTERN = /^\+[0-9][0-9 ()-]{6,22}$/u;

/** An empty field is no number. */
const number = (pattern: RegExp) =>
  z
    .string()
    .trim()
    .nullable()
    .transform((value) => (value === null || value === "" ? null : value))
    .refine((value) => value === null || pattern.test(value), { message: "invalid" });

export const serviceDocumentSchema = z.strictObject({
  title: line(1, SERVICE_LIMITS.title),
  /** What it offers, in one line. */
  summary: line(0, SERVICE_LIMITS.summary),
  category: z.enum(SERVICE_CATEGORIES),
  hours: openingHoursSchema.nullable(),
  phone: number(PHONE_PATTERN),
  whatsapp: number(WHATSAPP_PATTERN),
  /** The address in words («Calle Bolívar 12, frente a la plaza»); empty when there is none. */
  address: line(0, SERVICE_LIMITS.address),
  location: geoPointSchema.nullable(),
});

export type ServiceDocument = z.infer<typeof serviceDocumentSchema>;

export type ServiceIssueCode = "invalid" | "required";

export interface ServiceIssue {
  readonly path: string;
  readonly code: ServiceIssueCode;
}

export type ServiceValidation =
  | { readonly ok: true; readonly value: ServiceDocument }
  | { readonly ok: false; readonly issues: readonly ServiceIssue[] };

export function validateServiceDocument(input: unknown): ServiceValidation {
  const parsed = serviceDocumentSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      code: "invalid" as const,
    })),
  };
}

/** What a draft still needs before it is published: a way for visitors to find it. */
export function servicePublicationIssues(document: ServiceDocument): ServiceIssue[] {
  return document.address === "" && document.location === null
    ? [{ path: "address", code: "required" }]
    : [];
}

export function emptyServiceDocument(title: string, category: ServiceCategory): ServiceDocument {
  return {
    title,
    summary: "",
    category,
    hours: null,
    phone: null,
    whatsapp: null,
    address: "",
    location: null,
  };
}

/** A published service as the portal shows it (its card, its pin). */
export interface PublishedService {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly category: ServiceCategory;
  readonly hours: OpeningHours | null;
  readonly phone: string | null;
  readonly whatsapp: string | null;
  readonly address: string | null;
  readonly location: { readonly lat: number; readonly lng: number } | null;
}

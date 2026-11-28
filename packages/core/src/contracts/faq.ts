import { z } from "zod";

import type { RichText } from "./rich-text";
import { richTextSchema } from "./rich-text";

/**
 * A frequently asked question of the municipality (ADR-074): the question, a short answer that
 * visitors and search engines read first, optional details, a topic of the platform's list and,
 * optionally, the destination or event it is about. Mirrors `private.is_valid_faq_draft`.
 */

export const FAQ_LIMITS = {
  question: 120,
  answer: 300,
} as const;

/** The platform's topics, in the order the portal shows them. */
export const FAQ_TOPICS = [
  "getting_there",
  "hours",
  "services",
  "history",
  "visit",
  "other",
] as const;
export type FaqTopic = (typeof FAQ_TOPICS)[number];

export const FAQ_TOPIC_NAMES: Readonly<Record<FaqTopic, string>> = {
  getting_there: "Cómo llegar",
  hours: "Horarios y precios",
  services: "Servicios",
  history: "Historia y cultura",
  visit: "La visita",
  other: "Otras preguntas",
};

const NO_CONTROL_CHARACTERS = /^[^\p{Cc}]*$/u;

const line = (min: number, max: number) =>
  z.string().trim().min(min).max(max).regex(NO_CONTROL_CHARACTERS);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const faqDocumentSchema = z.strictObject({
  /** The question, as a visitor would ask it. */
  title: line(1, FAQ_LIMITS.question),
  /** The answer in one or two sentences: what the page and search engines show. */
  summary: line(0, FAQ_LIMITS.answer),
  /** «Más detalles», with the format of the destinations. */
  body: richTextSchema,
  topic: z.enum(FAQ_TOPICS),
  /** A destination or an event of the municipality it is about. */
  placeId: z.string().regex(UUID).nullable(),
});

export type FaqDocument = z.infer<typeof faqDocumentSchema>;

export type FaqIssueCode = "invalid" | "required";

export interface FaqIssue {
  readonly path: string;
  readonly code: FaqIssueCode;
}

export type FaqValidation =
  | { readonly ok: true; readonly value: FaqDocument }
  | { readonly ok: false; readonly issues: readonly FaqIssue[] };

export function validateFaqDocument(input: unknown): FaqValidation {
  const parsed = faqDocumentSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      code: "invalid" as const,
    })),
  };
}

/** What a draft still needs before it is published: its answer. */
export function faqPublicationIssues(document: FaqDocument): FaqIssue[] {
  return document.summary === "" ? [{ path: "summary", code: "required" }] : [];
}

export function emptyFaqDocument(question: string): FaqDocument {
  return { title: question, summary: "", body: [], topic: "other", placeId: null };
}

/** A published question as the portal shows it. */
export interface PublishedFaq {
  readonly slug: string;
  readonly question: string;
  readonly answer: string;
  readonly body: RichText;
  readonly topic: FaqTopic;
  /** The published destination or event it is about. */
  readonly place: {
    readonly kind: "destination" | "event";
    readonly slug: string;
    readonly title: string;
  } | null;
  readonly publishedAt: string;
}

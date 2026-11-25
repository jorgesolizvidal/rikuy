import { z } from "zod";

import type { RichText } from "./rich-text";
import { richTextSchema } from "./rich-text";

/**
 * A story of the community (ADR-069): what a neighbour tells about the municipality, loaded by
 * the municipality's team on their behalf. Who tells it (or «anónimo», and then no name is
 * kept), their community or relation with the place, an optional destination it is about, the
 * text, and whether the person agreed to publish it. Mirrors `private.is_valid_story_draft`.
 */

export const STORY_LIMITS = {
  title: 120,
  summary: 300,
  author: 80,
  community: 120,
} as const;

const NO_CONTROL_CHARACTERS = /^[^\p{Cc}]*$/u;

const line = (min: number, max: number) =>
  z.string().trim().min(min).max(max).regex(NO_CONTROL_CHARACTERS);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const storyDocumentSchema = z
  .strictObject({
    title: line(1, STORY_LIMITS.title),
    /** One line for the lists and the destination's page. */
    summary: line(0, STORY_LIMITS.summary),
    body: richTextSchema,
    /** Who tells it; empty when it is anonymous (the name is not kept). */
    author: line(0, STORY_LIMITS.author),
    anonymous: z.boolean(),
    /** Their community or relation with the place («Vecina de la plaza»). */
    community: line(0, STORY_LIMITS.community),
    /** A destination of the municipality it is about. */
    placeId: z.string().regex(UUID).nullable(),
    /** «La persona aceptó que se publique su relato». */
    consent: z.boolean(),
  })
  // «Anónimo» keeps no name, whatever the form sent.
  .transform((document) => (document.anonymous ? { ...document, author: "" } : document));

export type StoryDocument = z.infer<typeof storyDocumentSchema>;

export type StoryIssueCode = "invalid" | "required";

export interface StoryIssue {
  readonly path: string;
  readonly code: StoryIssueCode;
}

export type StoryValidation =
  | { readonly ok: true; readonly value: StoryDocument }
  | { readonly ok: false; readonly issues: readonly StoryIssue[] };

export function validateStoryDocument(input: unknown): StoryValidation {
  const parsed = storyDocumentSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      code: "invalid" as const,
    })),
  };
}

/** What a draft still needs before it is published: its text, who tells it and the consent. */
export function storyPublicationIssues(document: StoryDocument): StoryIssue[] {
  const issues: StoryIssue[] = [];
  if (document.body.length === 0) issues.push({ path: "body", code: "required" });
  if (!document.anonymous && document.author === "") {
    issues.push({ path: "author", code: "required" });
  }
  if (!document.consent) issues.push({ path: "consent", code: "required" });
  return issues;
}

export function emptyStoryDocument(title: string): StoryDocument {
  return {
    title,
    summary: "",
    body: [],
    author: "",
    anonymous: false,
    community: "",
    placeId: null,
    consent: false,
  };
}

/** How the portal and the assistant name who tells it: «Doña Rosa Vargas» or «Anónimo». */
export function storyTeller(story: {
  readonly author: string | null;
  readonly anonymous: boolean;
}): string {
  return story.anonymous || !story.author ? "Anónimo" : story.author;
}

/** A published story as the portal shows it. */
export interface PublishedStory {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly body: RichText;
  /** Null when it is anonymous. */
  readonly author: string | null;
  readonly anonymous: boolean;
  readonly community: string | null;
  /** The published destination it is about. */
  readonly place: { readonly slug: string; readonly title: string } | null;
  readonly publishedAt: string;
}

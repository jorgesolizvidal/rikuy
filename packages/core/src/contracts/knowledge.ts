import { z } from "zod";

import { richTextSchema } from "./rich-text";

/**
 * The assistant's knowledge (ADR-037): what a municipality writes or uploads for the
 * assistant to read, the extracted text of its documents, the passages a search returns and
 * the citations an answer may carry (D5).
 */

export const KNOWLEDGE_LIMITS = { title: 120, summary: 300 } as const;

/** A document attached to a knowledge revision: a version of purpose "document". */
export const knowledgeDocumentReferenceSchema = z.strictObject({
  assetId: z.uuid(),
  version: z.number().int().min(1).max(999_999),
});

/** What the editor saves. Same as private.is_valid_knowledge_draft in the database. */
const line = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);

export const knowledgeDocumentSchema = z.strictObject({
  title: line(1, KNOWLEDGE_LIMITS.title),
  summary: line(0, KNOWLEDGE_LIMITS.summary),
  body: richTextSchema,
  document: knowledgeDocumentReferenceSchema.nullable(),
});

export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;
export type KnowledgeDocumentReference = z.infer<typeof knowledgeDocumentReferenceSchema>;

export const DOCUMENT_MIMES = ["application/pdf", "text/plain"] as const;
export type DocumentMime = (typeof DOCUMENT_MIMES)[number];

/** Limits of a knowledge document (ADR-037). */
export const DOCUMENT_RULES = {
  maxBytes: 20 * 1024 * 1024,
  maxPages: 2000,
  maxCharacters: 5_000_000,
  /** Below this, a PDF page has no real text (a scan, a picture). */
  minCharactersPerPage: 40,
} as const;

/** Why a document cannot be used (stored as the version's rejection reason). */
export const DOCUMENT_PROBLEMS = [
  "not_a_document",
  "too_heavy",
  "unreadable",
  "encrypted",
  "no_text",
  "too_many_pages",
  "too_long",
] as const;
export type DocumentProblem = (typeof DOCUMENT_PROBLEMS)[number];

/** Folder of a version's extracted text, inside the version prefix. */
export const DOCUMENT_TEXT_FILE = "document/text.json";

/** Same as private.is_valid_document_manifest. */
export const documentManifestSchema = z.strictObject({
  version: z.literal(1),
  format: z.enum(["pdf", "txt"]),
  /** Pages of a PDF, or printed page marks found in a text file; null when unknown. */
  pages: z.number().int().min(1).max(DOCUMENT_RULES.maxPages).nullable(),
  characters: z.number().int().min(1).max(DOCUMENT_RULES.maxCharacters),
  textFile: z.literal(DOCUMENT_TEXT_FILE),
  encoding: z.enum(["utf-8", "windows-1252", "pdf"]),
});

export type DocumentManifest = z.infer<typeof documentManifestSchema>;

/** The extracted text, page by page (`page` is null in a text file without page marks). */
export const documentTextSchema = z.strictObject({
  version: z.literal(1),
  pages: z
    .array(z.strictObject({ page: z.number().int().min(1).max(9999).nullable(), text: z.string() }))
    .max(DOCUMENT_RULES.maxPages),
});

export type DocumentText = z.infer<typeof documentTextSchema>;
export type DocumentPage = DocumentText["pages"][number];

/** Where a passage comes from: a content item (destination, event, knowledge) or a tour. */
export type KnowledgeSource = "content" | "tour";
export type KnowledgeContentKind = "destination" | "event" | "knowledge";

/** One passage a search found, from what the municipality has published now. */
export interface KnowledgePassage {
  readonly chunkId: string;
  readonly source: KnowledgeSource;
  /** The content item, or the tour. */
  readonly sourceId: string;
  /** Its published revision number. */
  readonly sourceVersion: number;
  readonly kind: KnowledgeContentKind;
  readonly slug: string;
  readonly title: string;
  readonly heading: string | null;
  readonly text: string;
  readonly pages: { readonly from: number; readonly to: number } | null;
  readonly sceneId: string | null;
  readonly hotspotId: string | null;
  /** An event that already ended (or the tour of one). */
  readonly ended: boolean;
  readonly score: number;
}

/** What an answer cites (D5): exists only inside the passages that were retrieved. */
export const knowledgeCitationSchema = z.strictObject({
  source: z.enum(["content", "tour"]),
  sourceId: z.uuid(),
  sourceVersion: z.number().int().min(1),
  chunkId: z.uuid(),
});

export type KnowledgeCitation = z.infer<typeof knowledgeCitationSchema>;

/** A citation as the visitor sees it: never an internal id, never a private address. */
export interface PublicCitation {
  readonly title: string;
  /** "Destino", "Evento", "Tour 360°" or "Documento". */
  readonly label: string;
  /** Portal path (destination, event, tour scene), or null for documents. */
  readonly href: string | null;
  /** "pág. 14" or "págs. 14–15". */
  readonly page: string | null;
  readonly ended: boolean;
}

/** One published source and whether the assistant already has it. */
export interface KnowledgeIndexEntry {
  readonly source: KnowledgeSource;
  readonly sourceId: string;
  readonly kind: KnowledgeContentKind;
  readonly slug: string;
  readonly title: string;
  readonly revisionNo: number;
  readonly publishedAt: string;
  /** Null while the current revision is not indexed. */
  readonly chunks: number | null;
  readonly indexedAt: string | null;
  readonly job: { readonly status: string; readonly errorCode: string | null } | null;
}

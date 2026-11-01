import type { JobStatus } from "../../contracts/jobs";
import type {
  DocumentManifest,
  DocumentPage,
  DocumentProblem,
  KnowledgeDocument,
  KnowledgeIndexEntry,
  KnowledgePassage,
} from "../../contracts/knowledge";
import type {
  ContentRecord,
  CreateContentOutcome,
  DiscardDraftOutcome,
  PublishContentOutcome,
  RestoreContentOutcome,
} from "../content/ports";
import type { JobLease } from "../jobs/ports";
import type { Chunk } from "../../domain/knowledge/chunker";

/** Where a knowledge item stands: retired = published once, not used by the assistant now. */
export type KnowledgeStatus = "draft" | "published" | "changed" | "retired";

export interface KnowledgeListEntry {
  readonly contentId: string;
  readonly slug: string;
  readonly title: string;
  readonly status: KnowledgeStatus;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
}

export type DocumentStatus = "uploading" | "processing" | "ready" | "rejected";

/** A document version as the editor shows it. */
export interface DocumentVersionView {
  readonly versionId: string;
  readonly assetId: string;
  readonly version: number;
  readonly status: DocumentStatus;
  readonly declaredMime: string;
  readonly declaredBytes: number;
  readonly problem: DocumentProblem | null;
  readonly manifest: DocumentManifest | null;
  readonly job: { readonly status: JobStatus; readonly errorCode: string | null } | null;
}

export type SaveKnowledgeOutcome =
  | { readonly status: "saved"; readonly revisionNo: number; readonly editCount: number }
  | { readonly status: "invalid"; readonly reason: "shape" | "document" }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export type PublishKnowledgeOutcome =
  PublishContentOutcome | { readonly status: "invalid"; readonly reason: "document" };

export type RetireKnowledgeOutcome =
  { readonly status: "retired" } | { readonly status: "conflict" | "forbidden" | "not_found" };

export type DocumentSubmitOutcome =
  "processing" | "ready" | "rejected" | "not_uploaded" | "not_found" | "forbidden";

/** The assistant's knowledge with the signed-in user's session (RLS and RPC checks apply). */
export interface KnowledgeRepository {
  list(tenantId: string): Promise<KnowledgeListEntry[]>;
  create(tenantId: string, slug: string, title: string): Promise<CreateContentOutcome>;
  find(tenantId: string, contentId: string): Promise<ContentRecord<KnowledgeDocument> | null>;
  /** Any revision of the item (a retired item shows its last version). */
  revisionDocument(tenantId: string, revisionId: string): Promise<KnowledgeDocument | null>;
  saveDraft(
    tenantId: string,
    contentId: string,
    document: KnowledgeDocument,
    expectedEdit: number | null,
  ): Promise<SaveKnowledgeOutcome>;
  publish(
    tenantId: string,
    contentId: string,
    expectedEdit: number,
  ): Promise<PublishKnowledgeOutcome>;
  retire(tenantId: string, contentId: string): Promise<RetireKnowledgeOutcome>;
  restore(tenantId: string, contentId: string, revisionId: string): Promise<RestoreContentOutcome>;
  discardDraft(
    tenantId: string,
    contentId: string,
    expectedEdit: number,
  ): Promise<DiscardDraftOutcome>;
  /** The document version of this tenant with that asset and version, or null. */
  findDocument(
    tenantId: string,
    assetId: string,
    version: number,
  ): Promise<DocumentVersionView | null>;
  /** The browser finished uploading: move to processing and enqueue the job (one transaction). */
  submitDocument(tenantId: string, versionId: string): Promise<DocumentSubmitOutcome>;
  /** What the assistant would find now (published sources only). */
  search(tenantId: string, query: string, limit: number): Promise<KnowledgePassage[]>;
  /** Every published source and whether its current revision is indexed. */
  indexStatus(tenantId: string): Promise<KnowledgeIndexEntry[]>;
}

// ── Worker side ────────────────────────────────────────────────────────────

export interface DocumentSource {
  readonly status: DocumentStatus;
  readonly originalPath: string;
  readonly declaredMime: string;
  /** {tenant}/{asset}/{version}/ */
  readonly prefix: string;
}

/** worker_api for media.extract_document, always under the job's lease. */
export interface DocumentStore {
  source(lease: JobLease): Promise<DocumentSource | "not_found" | "lease_lost">;
  complete(
    lease: JobLease,
    original: {
      readonly mime: "application/pdf" | "text/plain";
      readonly bytes: number;
      readonly sha256: string;
    },
    manifest: DocumentManifest,
  ): Promise<"ready" | "already_settled" | "not_found" | "lease_lost">;
  reject(
    lease: JobLease,
    problem: DocumentProblem,
  ): Promise<"rejected" | "already_settled" | "not_found" | "lease_lost">;
}

/** Reads the text of a PDF page by page (pdf.js in @rikuy/db). */
export interface PdfTextReader {
  read(
    bytes: Uint8Array,
    limits: { readonly maxPages: number },
  ): Promise<
    | { readonly status: "ok"; readonly pages: readonly DocumentPage[] }
    | { readonly status: "encrypted" | "unreadable" | "too_many_pages" }
  >;
}

export interface StoredChunk extends Chunk {
  readonly sha256: string;
}

/** worker_api for knowledge.index, always under the job's lease. */
export interface KnowledgeIndexStore {
  /** The revision to index, as the database describes it (validated by the indexer). */
  source(lease: JobLease): Promise<unknown>;
  store(
    lease: JobLease,
    chunkerVersion: number,
    title: string,
    chunks: readonly StoredChunk[],
  ): Promise<"stored" | "not_found" | "lease_lost">;
}

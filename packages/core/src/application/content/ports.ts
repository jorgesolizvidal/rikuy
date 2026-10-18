import type { DestinationDocument } from "../../contracts/destination";

/** Where a destination stands for its editors. */
export type ContentStatus = "draft" | "published" | "changed";

export interface DestinationListEntry {
  readonly contentId: string;
  readonly slug: string;
  readonly title: string;
  /** draft: never published · published: no open draft · changed: published + open draft */
  readonly status: ContentStatus;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
}

export interface ContentRevisionEntry {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly title: string;
  readonly sealedAt: string;
}

export interface OpenDraft {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly editCount: number;
  readonly updatedAt: string;
  readonly document: DestinationDocument;
}

export interface PublishedRevision {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly document: DestinationDocument;
}

export interface DestinationRecord {
  readonly contentId: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly draft: OpenDraft | null;
  readonly published: PublishedRevision | null;
  /** Sealed revisions, newest first. */
  readonly history: readonly ContentRevisionEntry[];
}

export type CreateContentOutcome =
  | { readonly status: "created"; readonly contentId: string }
  | { readonly status: "slug_taken" | "invalid" | "forbidden" };

export type SaveContentOutcome =
  | { readonly status: "saved"; readonly revisionNo: number; readonly editCount: number }
  | { readonly status: "invalid"; readonly reason: "shape" | "media" }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export type PublishContentOutcome =
  | { readonly status: "published"; readonly revisionNo: number }
  | { readonly status: "invalid"; readonly reason: "incomplete" | "media" }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export type RestoreContentOutcome =
  | { readonly status: "restored"; readonly revisionNo: number }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export type DiscardDraftOutcome =
  | { readonly status: "discarded" }
  | { readonly status: "never_published" | "conflict" | "forbidden" | "not_found" };

/** Editorial content with the signed-in user's session (RLS and RPC checks apply). */
export interface ContentRepository {
  listDestinations(tenantId: string): Promise<DestinationListEntry[]>;
  createDestination(tenantId: string, slug: string, title: string): Promise<CreateContentOutcome>;
  findDestination(tenantId: string, contentId: string): Promise<DestinationRecord | null>;
  /** Any revision of the item (to preview history). */
  revisionDocument(tenantId: string, revisionId: string): Promise<DestinationDocument | null>;
  saveDraft(
    tenantId: string,
    contentId: string,
    document: DestinationDocument,
    expectedEdit: number | null,
  ): Promise<SaveContentOutcome>;
  publish(
    tenantId: string,
    contentId: string,
    expectedEdit: number,
  ): Promise<PublishContentOutcome>;
  restore(tenantId: string, contentId: string, revisionId: string): Promise<RestoreContentOutcome>;
  discardDraft(
    tenantId: string,
    contentId: string,
    expectedEdit: number,
  ): Promise<DiscardDraftOutcome>;
}

export interface PublishedDestinationSummary {
  readonly contentId: string;
  readonly slug: string;
  readonly revisionNo: number;
  readonly title: string;
  readonly summary: string;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly cover: DestinationDocument["cover"];
  readonly publishedAt: string;
}

export interface PublishedDestination {
  readonly contentId: string;
  readonly slug: string;
  readonly revisionNo: number;
  readonly document: DestinationDocument;
  readonly publishedAt: string;
  readonly updatedAt: string;
}

/** Anonymous reads for portals: only published revisions of active tenants. */
export interface PublishedDestinationReader {
  list(tenantId: string): Promise<PublishedDestinationSummary[]>;
  find(tenantId: string, slug: string): Promise<PublishedDestination | null>;
}

import type { PublishedStory, StoryDocument } from "../../contracts/story";
import type {
  ContentRecord,
  CreateContentOutcome,
  DiscardDraftOutcome,
  RestoreContentOutcome,
} from "../content/ports";

/**
 * Where a story stands for its editors (ADR-069): `draft` never published · `published` ·
 * `changed` published with an open draft · `retired` published once, taken out.
 */
export type StoryStatus = "draft" | "published" | "changed" | "retired";

export interface StoryListEntry {
  readonly contentId: string;
  readonly slug: string;
  readonly title: string;
  /** «Doña Rosa Vargas», «Anónimo», or null while nobody is set. */
  readonly teller: string | null;
  readonly status: StoryStatus;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
}

/** A destination a story may be about (published or not: its draft may be ahead). */
export interface StoryPlaceOption {
  readonly contentId: string;
  readonly title: string;
}

export type SaveStoryOutcome =
  | { readonly status: "saved"; readonly revisionNo: number; readonly editCount: number }
  | { readonly status: "invalid"; readonly reason?: "place" }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export type PublishStoryOutcome =
  | { readonly status: "published"; readonly revisionNo: number }
  | { readonly status: "invalid"; readonly reason: "incomplete" | "consent" }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export type RetireStoryOutcome =
  { readonly status: "retired" } | { readonly status: "conflict" | "forbidden" | "not_found" };

/** The municipality's stories with the signed-in user's session (RLS and RPC checks apply). */
export interface StoryRepository {
  list(tenantId: string): Promise<StoryListEntry[]>;
  /** The municipality's destinations, for «¿Sobre qué lugar?». */
  places(tenantId: string): Promise<StoryPlaceOption[]>;
  create(tenantId: string, slug: string, title: string): Promise<CreateContentOutcome>;
  find(tenantId: string, contentId: string): Promise<ContentRecord<StoryDocument> | null>;
  /** Any revision of the item (a retired story shows its last version). */
  revisionDocument(tenantId: string, revisionId: string): Promise<StoryDocument | null>;
  saveDraft(
    tenantId: string,
    contentId: string,
    document: StoryDocument,
    expectedEdit: number | null,
  ): Promise<SaveStoryOutcome>;
  publish(tenantId: string, contentId: string, expectedEdit: number): Promise<PublishStoryOutcome>;
  retire(tenantId: string, contentId: string): Promise<RetireStoryOutcome>;
  restore(tenantId: string, contentId: string, revisionId: string): Promise<RestoreContentOutcome>;
  discardDraft(
    tenantId: string,
    contentId: string,
    expectedEdit: number,
  ): Promise<DiscardDraftOutcome>;
}

/** The stories the portal shows (anonymous: public.portal_stories). */
export interface PublishedStoryReader {
  list(tenantId: string): Promise<PublishedStory[]>;
}

import type { FaqDocument, FaqTopic, PublishedFaq } from "../../contracts/faq";
import type {
  ContentRecord,
  CreateContentOutcome,
  DiscardDraftOutcome,
  RestoreContentOutcome,
} from "../content/ports";

/**
 * Where a question stands for its editors (ADR-074): `draft` never published · `published` ·
 * `changed` published with an open draft · `retired` published once, taken out.
 */
export type FaqStatus = "draft" | "published" | "changed" | "retired";

export interface FaqListEntry {
  readonly contentId: string;
  readonly slug: string;
  readonly question: string;
  readonly topic: FaqTopic;
  readonly status: FaqStatus;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
}

/** A destination or an event a question may be about. */
export interface FaqPlaceOption {
  readonly contentId: string;
  readonly kind: "destination" | "event";
  readonly title: string;
}

export type SaveFaqOutcome =
  | { readonly status: "saved"; readonly revisionNo: number; readonly editCount: number }
  | { readonly status: "invalid"; readonly reason?: "place" }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export type PublishFaqOutcome =
  | { readonly status: "published"; readonly revisionNo: number }
  | { readonly status: "invalid"; readonly reason: "incomplete" }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export type RetireFaqOutcome =
  { readonly status: "retired" } | { readonly status: "conflict" | "forbidden" | "not_found" };

/** The municipality's questions with the signed-in user's session (RLS and RPC checks apply). */
export interface FaqRepository {
  list(tenantId: string): Promise<FaqListEntry[]>;
  /** The municipality's destinations and events, for «¿Sobre qué lugar?». */
  places(tenantId: string): Promise<FaqPlaceOption[]>;
  create(tenantId: string, slug: string, title: string): Promise<CreateContentOutcome>;
  find(tenantId: string, contentId: string): Promise<ContentRecord<FaqDocument> | null>;
  /** Any revision of the item (a retired question shows its last version). */
  revisionDocument(tenantId: string, revisionId: string): Promise<FaqDocument | null>;
  saveDraft(
    tenantId: string,
    contentId: string,
    document: FaqDocument,
    expectedEdit: number | null,
  ): Promise<SaveFaqOutcome>;
  publish(tenantId: string, contentId: string, expectedEdit: number): Promise<PublishFaqOutcome>;
  retire(tenantId: string, contentId: string): Promise<RetireFaqOutcome>;
  restore(tenantId: string, contentId: string, revisionId: string): Promise<RestoreContentOutcome>;
  discardDraft(
    tenantId: string,
    contentId: string,
    expectedEdit: number,
  ): Promise<DiscardDraftOutcome>;
}

/** The questions the portal shows (anonymous: public.portal_faqs). */
export interface PublishedFaqReader {
  list(tenantId: string): Promise<PublishedFaq[]>;
}

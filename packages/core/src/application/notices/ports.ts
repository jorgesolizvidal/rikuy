import type { NoticeDocument, NoticeValidity, PublishedNotice } from "../../contracts/notice";
import type {
  ContentRecord,
  CreateContentOutcome,
  DiscardDraftOutcome,
  RestoreContentOutcome,
} from "../content/ports";

/**
 * Where a notice stands for its editors (ADR-069): `draft` never published · `published`
 * (in force, programmed or ended: see its validity) · `changed` published with an open draft
 * · `retired` published once, taken out by hand.
 */
export type NoticeStatus = "draft" | "published" | "changed" | "retired";

export interface NoticeListEntry {
  readonly contentId: string;
  readonly slug: string;
  readonly title: string;
  readonly status: NoticeStatus;
  /** The published revision's validity (null when not published). */
  readonly published: NoticeValidity | null;
  /** The open draft's (or, if none, the last version's) validity. */
  readonly validity: NoticeValidity;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
}

/** A destination or an event a notice may name (published or not: its draft may be ahead). */
export interface NoticePlaceOption {
  readonly contentId: string;
  readonly kind: "destination" | "event";
  readonly title: string;
}

export type SaveNoticeOutcome =
  | { readonly status: "saved"; readonly revisionNo: number; readonly editCount: number }
  | { readonly status: "invalid"; readonly reason: "shape" | "place" }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export type PublishNoticeOutcome =
  | { readonly status: "published"; readonly revisionNo: number }
  | { readonly status: "invalid"; readonly reason: "incomplete" | "validity" }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export type RetireNoticeOutcome =
  { readonly status: "retired" } | { readonly status: "conflict" | "forbidden" | "not_found" };

/** The municipality's notices with the signed-in user's session (RLS and RPC checks apply). */
export interface NoticeRepository {
  list(tenantId: string): Promise<NoticeListEntry[]>;
  create(tenantId: string, slug: string, title: string): Promise<CreateContentOutcome>;
  find(tenantId: string, contentId: string): Promise<ContentRecord<NoticeDocument> | null>;
  /** Any revision of the item (a retired notice shows its last version). */
  revisionDocument(tenantId: string, revisionId: string): Promise<NoticeDocument | null>;
  saveDraft(
    tenantId: string,
    contentId: string,
    document: NoticeDocument,
    expectedEdit: number | null,
  ): Promise<SaveNoticeOutcome>;
  publish(tenantId: string, contentId: string, expectedEdit: number): Promise<PublishNoticeOutcome>;
  retire(tenantId: string, contentId: string): Promise<RetireNoticeOutcome>;
  restore(tenantId: string, contentId: string, revisionId: string): Promise<RestoreContentOutcome>;
  discardDraft(
    tenantId: string,
    contentId: string,
    expectedEdit: number,
  ): Promise<DiscardDraftOutcome>;
  /** The destinations and events of the municipality, for the place picker. */
  places(tenantId: string): Promise<NoticePlaceOption[]>;
  /** The municipality's time zone: validities are local to it. */
  timezone(tenantId: string): Promise<string>;
}

/** The notices the portal shows (anonymous: public.portal_notices). */
export interface PublishedNoticeReader {
  /** In force now, and those that start within a day (the browser decides which to show). */
  list(tenantId: string): Promise<PublishedNotice[]>;
}

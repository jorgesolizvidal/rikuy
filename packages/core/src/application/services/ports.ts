import type { PublishedService, ServiceCategory, ServiceDocument } from "../../contracts/service";
import type {
  ContentRecord,
  CreateContentOutcome,
  DiscardDraftOutcome,
  RestoreContentOutcome,
} from "../content/ports";

/**
 * Where a service stands for its editors (ADR-069): `draft` never published · `published` ·
 * `changed` published with an open draft · `retired` published once, taken out (it closed).
 */
export type ServiceStatus = "draft" | "published" | "changed" | "retired";

export interface ServiceListEntry {
  readonly contentId: string;
  readonly slug: string;
  readonly title: string;
  readonly category: ServiceCategory | null;
  readonly status: ServiceStatus;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
}

export type SaveServiceOutcome =
  | { readonly status: "saved"; readonly revisionNo: number; readonly editCount: number }
  | { readonly status: "invalid" }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export type PublishServiceOutcome =
  | { readonly status: "published"; readonly revisionNo: number }
  | { readonly status: "invalid" }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export type RetireServiceOutcome =
  { readonly status: "retired" } | { readonly status: "conflict" | "forbidden" | "not_found" };

/** The municipality's services with the signed-in user's session (RLS and RPC checks apply). */
export interface ServiceRepository {
  list(tenantId: string): Promise<ServiceListEntry[]>;
  create(tenantId: string, slug: string, title: string): Promise<CreateContentOutcome>;
  find(tenantId: string, contentId: string): Promise<ContentRecord<ServiceDocument> | null>;
  /** Any revision of the item (a retired service shows its last version). */
  revisionDocument(tenantId: string, revisionId: string): Promise<ServiceDocument | null>;
  saveDraft(
    tenantId: string,
    contentId: string,
    document: ServiceDocument,
    expectedEdit: number | null,
  ): Promise<SaveServiceOutcome>;
  publish(
    tenantId: string,
    contentId: string,
    expectedEdit: number,
  ): Promise<PublishServiceOutcome>;
  retire(tenantId: string, contentId: string): Promise<RetireServiceOutcome>;
  restore(tenantId: string, contentId: string, revisionId: string): Promise<RestoreContentOutcome>;
  discardDraft(
    tenantId: string,
    contentId: string,
    expectedEdit: number,
  ): Promise<DiscardDraftOutcome>;
}

/** The services the portal shows (anonymous: public.portal_services). */
export interface PublishedServiceReader {
  list(tenantId: string): Promise<PublishedService[]>;
}

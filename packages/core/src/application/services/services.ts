import {
  SERVICE_CATEGORIES,
  servicePublicationIssues,
  validateServiceDocument,
  type PublishedService,
  type ServiceCategory,
  type ServiceDocument,
  type ServiceIssue,
} from "../../contracts/service";
import type { OrganizationMembership } from "../../contracts/organization";
import { SERVICE_CATEGORY_INFO } from "../../domain/services/categories";
import type { ContentRecord, DiscardDraftOutcome, RestoreContentOutcome } from "../content/ports";
import {
  canEditContent,
  canPublishContent,
  createContent,
  type CreateContentResult,
} from "../content/editing";
import type { RetireServiceOutcome, ServiceListEntry, ServiceRepository } from "./ports";

/**
 * «Servicios locales» (ADR-069): where to eat, sleep, take out cash, catch transport. Same
 * flow as destinations (editors prepare, owners and admins publish), plus «Retirar» for one
 * that closed. Grouped by the platform's categories, in their order.
 */

export interface ServiceGroup<T> {
  readonly category: ServiceCategory;
  /** «Dónde comer», «Cajeros y bancos»… */
  readonly section: string;
  readonly items: readonly T[];
}

/** In the platform's order of categories; empty groups out. */
export function groupServices<T extends { readonly category: ServiceCategory | null }>(
  items: readonly T[],
): ServiceGroup<T>[] {
  return SERVICE_CATEGORIES.map((category) => ({
    category,
    section: SERVICE_CATEGORY_INFO[category].section,
    items: items.filter((item) => (item.category ?? "other") === category),
  })).filter((group) => group.items.length > 0);
}

const ORDER = { draft: 1, changed: 0, published: 0, retired: 2 } as const;

/** Published and changed first, then drafts and retired; by name inside each. */
export async function listServices(
  membership: OrganizationMembership,
  repository: ServiceRepository,
): Promise<ServiceListEntry[]> {
  const entries = await repository.list(membership.tenantId);
  return [...entries].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.title.localeCompare(b.title, "es"),
  );
}

export function createService(
  membership: OrganizationMembership,
  input: { readonly title: unknown; readonly slug: unknown },
  repository: ServiceRepository,
): Promise<CreateContentResult> {
  return createContent(membership, input, (tenantId, slug, title) =>
    repository.create(tenantId, slug, title),
  );
}

export interface ServiceEditor {
  readonly record: ContentRecord<ServiceDocument>;
  /** The open draft, else the published revision, else (retired) the last version. */
  readonly document: ServiceDocument;
  readonly editCount: number | null;
  readonly retired: boolean;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
}

export async function loadServiceEditor(
  membership: OrganizationMembership,
  contentId: string,
  repository: ServiceRepository,
): Promise<ServiceEditor | null> {
  const record = await repository.find(membership.tenantId, contentId);
  if (record === null) return null;
  const last = record.history[0];
  const document =
    record.draft?.document ??
    record.published?.document ??
    (last ? await repository.revisionDocument(membership.tenantId, last.revisionId) : null);
  if (!document) return null;
  return {
    record,
    document,
    editCount: record.draft?.editCount ?? null,
    retired: record.published === null && record.history.length > 0,
    canEdit: canEditContent(membership.role),
    canPublish: canPublishContent(membership.role),
  };
}

export type SaveServiceResult =
  | { readonly status: "saved"; readonly revisionNo: number; readonly editCount: number }
  | { readonly status: "invalid"; readonly issues: readonly ServiceIssue[] }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export async function saveServiceDraft(
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  repository: ServiceRepository,
): Promise<SaveServiceResult> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  const validation = validateServiceDocument(input);
  if (!validation.ok) return { status: "invalid", issues: validation.issues };
  const outcome = await repository.saveDraft(
    membership.tenantId,
    contentId,
    validation.value,
    expectedEdit,
  );
  if (outcome.status !== "invalid") return outcome;
  return { status: "invalid", issues: [{ path: "", code: "invalid" }] };
}

export type PublishServiceResult =
  | { readonly status: "published"; readonly revisionNo: number }
  | { readonly status: "invalid"; readonly issues: readonly ServiceIssue[] }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

/** Saves the submitted values as the draft, then publishes it (seal + pointer + audit). */
export async function publishService(
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  repository: ServiceRepository,
): Promise<PublishServiceResult> {
  if (!canPublishContent(membership.role)) return { status: "forbidden" };
  const validation = validateServiceDocument(input);
  if (!validation.ok) return { status: "invalid", issues: validation.issues };
  const missing = servicePublicationIssues(validation.value);
  if (missing.length > 0) return { status: "invalid", issues: missing };

  const saved = await saveServiceDraft(
    membership,
    contentId,
    validation.value,
    expectedEdit,
    repository,
  );
  if (saved.status !== "saved") return saved;
  const outcome = await repository.publish(membership.tenantId, contentId, saved.editCount);
  if (outcome.status !== "invalid") return outcome;
  return { status: "invalid", issues: [{ path: "address", code: "required" }] };
}

export function retireService(
  membership: OrganizationMembership,
  contentId: string,
  repository: ServiceRepository,
): Promise<RetireServiceOutcome> {
  if (!canPublishContent(membership.role)) return Promise.resolve({ status: "forbidden" });
  return repository.retire(membership.tenantId, contentId);
}

export function restoreServiceRevision(
  membership: OrganizationMembership,
  contentId: string,
  revisionId: unknown,
  repository: ServiceRepository,
): Promise<RestoreContentOutcome> {
  if (!canPublishContent(membership.role)) return Promise.resolve({ status: "forbidden" });
  if (typeof revisionId !== "string" || revisionId === "") {
    return Promise.resolve({ status: "not_found" });
  }
  return repository.restore(membership.tenantId, contentId, revisionId);
}

export function discardServiceDraft(
  membership: OrganizationMembership,
  contentId: string,
  expectedEdit: unknown,
  repository: ServiceRepository,
): Promise<DiscardDraftOutcome> {
  if (!canEditContent(membership.role)) return Promise.resolve({ status: "forbidden" });
  if (typeof expectedEdit !== "number" || !Number.isInteger(expectedEdit)) {
    return Promise.resolve({ status: "conflict" });
  }
  return repository.discardDraft(membership.tenantId, contentId, expectedEdit);
}

/** The published services with a place on the map (the map's «Servicios» layer). */
export function servicesOnMap(services: readonly PublishedService[]): PublishedService[] {
  return services.filter((service) => service.location !== null);
}

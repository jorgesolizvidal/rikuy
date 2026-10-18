import {
  DESTINATION_LIMITS,
  documentImages,
  isValidContentSlug,
  publicationIssues,
  validateDestinationDocument,
  type DestinationDocument,
  type DestinationIssue,
} from "../../contracts/destination";
import type { MembershipRole, OrganizationMembership } from "../../contracts/organization";
import { slugify } from "../../domain/tenancy/slug";
import { publishContentImages } from "../media/content-images";
import type { MediaAdmin } from "../media/ports";
import type {
  ContentRepository,
  DestinationListEntry,
  DestinationRecord,
  DiscardDraftOutcome,
  RestoreContentOutcome,
} from "./ports";
import { PORTAL_PATHS } from "./portal";

/** Owners, admins and editors write drafts and upload photos. */
export function canEditContent(role: MembershipRole): boolean {
  return role === "owner" || role === "admin" || role === "editor";
}

/** Only owners and admins put content in front of visitors (publish or roll back). */
export function canPublishContent(role: MembershipRole): boolean {
  return role === "owner" || role === "admin";
}

/** "Mirador del Valle (Norte)" → "mirador-del-valle-norte", at most 80 characters. */
export function suggestContentSlug(title: string): string {
  return slugify(title, DESTINATION_LIMITS.slug);
}

export function listDestinations(
  membership: OrganizationMembership,
  repository: ContentRepository,
): Promise<DestinationListEntry[]> {
  return repository.listDestinations(membership.tenantId);
}

export type CreateDestinationResult =
  | { readonly status: "created"; readonly contentId: string }
  | { readonly status: "invalid"; readonly field: "title" | "slug" }
  | { readonly status: "slug_taken" | "forbidden" };

export async function createDestination(
  membership: OrganizationMembership,
  input: { readonly title: unknown; readonly slug: unknown },
  repository: ContentRepository,
): Promise<CreateDestinationResult> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title === "" || title.length > DESTINATION_LIMITS.title || /\p{Cc}/u.test(title)) {
    return { status: "invalid", field: "title" };
  }
  const typed = typeof input.slug === "string" ? input.slug.trim() : "";
  const slug = typed === "" ? suggestContentSlug(title) : typed;
  if (!isValidContentSlug(slug)) return { status: "invalid", field: "slug" };

  const outcome = await repository.createDestination(membership.tenantId, slug, title);
  switch (outcome.status) {
    case "created":
      return outcome;
    case "invalid":
      return { status: "invalid", field: "slug" };
    default:
      return { status: outcome.status };
  }
}

export interface DestinationEditor {
  readonly record: DestinationRecord;
  /** What the form starts from: the open draft, else the published revision. */
  readonly document: DestinationDocument;
  readonly editCount: number | null;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
  /** Public page of the destination, or null while it is not published (or no portal). */
  readonly portalPath: { readonly hostname: string; readonly path: string } | null;
}

export async function loadDestinationEditor(
  membership: OrganizationMembership,
  contentId: string,
  repository: ContentRepository,
): Promise<DestinationEditor | null> {
  const [record, hostname] = await Promise.all([
    repository.findDestination(membership.tenantId, contentId),
    repository.portalHostname(membership.tenantId),
  ]);
  if (record === null) return null;
  const document = record.draft?.document ?? record.published?.document;
  if (!document) return null;
  return {
    record,
    document,
    editCount: record.draft?.editCount ?? null,
    canEdit: canEditContent(membership.role),
    canPublish: canPublishContent(membership.role),
    portalPath:
      record.published && hostname
        ? { hostname, path: PORTAL_PATHS.destination(record.slug) }
        : null,
  };
}

export type SaveDestinationResult =
  | { readonly status: "saved"; readonly revisionNo: number; readonly editCount: number }
  | { readonly status: "invalid"; readonly issues: readonly DestinationIssue[] }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

const MEDIA_ISSUE: DestinationIssue = { path: "images", code: "media" };

/** Validates and stores the draft (opening one if the destination has none). */
export async function saveDestinationDraft(
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  repository: ContentRepository,
): Promise<SaveDestinationResult> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  const validation = validateDestinationDocument(input);
  if (!validation.ok) return { status: "invalid", issues: validation.issues };

  const outcome = await repository.saveDraft(
    membership.tenantId,
    contentId,
    validation.value,
    expectedEdit,
  );
  if (outcome.status !== "invalid") return outcome;
  return {
    status: "invalid",
    issues: outcome.reason === "media" ? [MEDIA_ISSUE] : [{ path: "", code: "invalid" }],
  };
}

export type PublishDestinationResult =
  | { readonly status: "published"; readonly revisionNo: number }
  | { readonly status: "invalid"; readonly issues: readonly DestinationIssue[] }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

/**
 * Saves the submitted values as the draft, publishes its images' derivatives and then
 * the revision itself (seal + public pointer + audit, one transaction).
 */
export async function publishDestination(
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  repository: ContentRepository,
  imagePublisher: Pick<MediaAdmin, "publish">,
): Promise<PublishDestinationResult> {
  if (!canPublishContent(membership.role)) return { status: "forbidden" };
  const validation = validateDestinationDocument(input);
  if (!validation.ok) return { status: "invalid", issues: validation.issues };
  const missing = publicationIssues(validation.value);
  if (missing.length > 0) return { status: "invalid", issues: missing };

  const saved = await saveDestinationDraft(
    membership,
    contentId,
    validation.value,
    expectedEdit,
    repository,
  );
  if (saved.status !== "saved") return saved;

  await publishContentImages(membership.tenantId, documentImages(validation.value), imagePublisher);

  const outcome = await repository.publish(membership.tenantId, contentId, saved.editCount);
  if (outcome.status !== "invalid") return outcome;
  return {
    status: "invalid",
    issues: outcome.reason === "media" ? [MEDIA_ISSUE] : publicationIssues(validation.value),
  };
}

export async function restoreDestinationRevision(
  membership: OrganizationMembership,
  contentId: string,
  revisionId: unknown,
  repository: ContentRepository,
): Promise<RestoreContentOutcome> {
  if (!canPublishContent(membership.role)) return { status: "forbidden" };
  if (typeof revisionId !== "string" || revisionId === "") return { status: "not_found" };
  return repository.restore(membership.tenantId, contentId, revisionId);
}

export async function discardDestinationDraft(
  membership: OrganizationMembership,
  contentId: string,
  expectedEdit: unknown,
  repository: ContentRepository,
): Promise<DiscardDraftOutcome> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  if (typeof expectedEdit !== "number" || !Number.isInteger(expectedEdit)) {
    return { status: "conflict" };
  }
  return repository.discardDraft(membership.tenantId, contentId, expectedEdit);
}

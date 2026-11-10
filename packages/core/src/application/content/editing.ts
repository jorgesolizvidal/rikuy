import {
  DESTINATION_LIMITS,
  isValidContentSlug,
  type DestinationIssue,
  type ImageReference,
} from "../../contracts/destination";
import type { MembershipRole, OrganizationMembership } from "../../contracts/organization";
import { slugify } from "../../domain/tenancy/slug";
import { publishContentImages } from "../media/content-images";
import type { MediaAdmin } from "../media/ports";
import type {
  ChangeSlugOutcome,
  ContentRecord,
  ContentRepository,
  CreateContentOutcome,
  PreviousSlug,
  SaveContentOutcome,
} from "./ports";

/**
 * What every kind of editorial content shares: roles, identifiers, the draft → publish
 * flow. Each kind (destination, event) brings its own validation and requirements.
 */

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

export interface ContentKindSpec<D> {
  validate(
    input: unknown,
  ):
    | { readonly ok: true; readonly value: D }
    | { readonly ok: false; readonly issues: readonly DestinationIssue[] };
  publicationIssues(document: D): DestinationIssue[];
  images(document: D): ImageReference[];
}

export type CreateContentResult =
  | { readonly status: "created"; readonly contentId: string }
  | { readonly status: "invalid"; readonly field: "title" | "slug" }
  | { readonly status: "slug_taken" | "forbidden" };

export async function createContent(
  membership: OrganizationMembership,
  input: { readonly title: unknown; readonly slug: unknown },
  create: (tenantId: string, slug: string, title: string) => Promise<CreateContentOutcome>,
): Promise<CreateContentResult> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title === "" || title.length > DESTINATION_LIMITS.title || /\p{Cc}/u.test(title)) {
    return { status: "invalid", field: "title" };
  }
  const typed = typeof input.slug === "string" ? input.slug.trim() : "";
  const slug = typed === "" ? suggestContentSlug(title) : typed;
  if (!isValidContentSlug(slug)) return { status: "invalid", field: "slug" };

  const outcome = await create(membership.tenantId, slug, title);
  switch (outcome.status) {
    case "created":
      return outcome;
    case "invalid":
      return { status: "invalid", field: "slug" };
    default:
      return { status: outcome.status };
  }
}

export interface ContentEditor<D> {
  readonly record: ContentRecord<D>;
  /** What the form starts from: the open draft, else the published revision. */
  readonly document: D;
  readonly editCount: number | null;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
  /** Public page, or null while it is not published (or the portal has no address). */
  readonly portalPath: { readonly hostname: string; readonly path: string } | null;
  /** Owners and admins change the address (ADR-047). */
  readonly canChangeSlug: boolean;
  /** Addresses it had before, which keep leading to it (newest first). */
  readonly previousSlugs: readonly PreviousSlug[];
}

export async function loadContentEditor<D>(
  membership: OrganizationMembership,
  contentId: string,
  find: () => Promise<ContentRecord<D> | null>,
  repository: Pick<ContentRepository, "portalHostname" | "previousSlugs">,
  publicPath: (slug: string) => string,
): Promise<ContentEditor<D> | null> {
  const [record, hostname, previousSlugs] = await Promise.all([
    find(),
    repository.portalHostname(membership.tenantId),
    repository.previousSlugs(membership.tenantId, contentId),
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
    portalPath: record.published && hostname ? { hostname, path: publicPath(record.slug) } : null,
    canChangeSlug: canPublishContent(membership.role),
    previousSlugs,
  };
}

export type ChangeSlugResult =
  | { readonly status: "changed"; readonly slug: string; readonly previousSlug: string | null }
  | {
      readonly status:
        | "invalid"
        | "unchanged"
        | "slug_taken"
        | "slug_previous"
        | "stale"
        | "too_many"
        | "forbidden"
        | "not_found";
    };

/**
 * Changes the address of a destination or event (ADR-047). Like publishing, it changes what
 * visitors open, so only owners and admins do it. A published content keeps its old address
 * leading to the new one (old links and printed QR codes keep working).
 */
export async function changeContentSlug(
  membership: OrganizationMembership,
  contentId: string,
  input: { readonly expectedSlug: unknown; readonly slug: unknown },
  repository: Pick<ContentRepository, "changeSlug">,
): Promise<ChangeSlugResult> {
  if (!canPublishContent(membership.role)) return { status: "forbidden" };
  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  const expected = typeof input.expectedSlug === "string" ? input.expectedSlug : "";
  if (!isValidContentSlug(slug) || !isValidContentSlug(expected)) return { status: "invalid" };
  if (slug === expected) return { status: "unchanged" };
  const outcome: ChangeSlugOutcome = await repository.changeSlug(
    membership.tenantId,
    contentId,
    expected,
    slug,
  );
  return outcome;
}

export type SaveContentResult =
  | { readonly status: "saved"; readonly revisionNo: number; readonly editCount: number }
  | { readonly status: "invalid"; readonly issues: readonly DestinationIssue[] }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

const MEDIA_ISSUE: DestinationIssue = { path: "images", code: "media" };

function storageIssues(reason: "shape" | "media" | "venue"): DestinationIssue[] {
  if (reason === "media") return [MEDIA_ISSUE];
  if (reason === "venue") return [{ path: "venueId", code: "invalid" }];
  return [{ path: "", code: "invalid" }];
}

export async function saveContentDraft<D>(
  spec: ContentKindSpec<D>,
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  save: (document: D) => Promise<SaveContentOutcome>,
): Promise<SaveContentResult> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  const validation = spec.validate(input);
  if (!validation.ok) return { status: "invalid", issues: validation.issues };
  const outcome = await save(validation.value);
  if (outcome.status !== "invalid") return outcome;
  return { status: "invalid", issues: storageIssues(outcome.reason) };
}

export type PublishContentResult =
  | { readonly status: "published"; readonly revisionNo: number }
  | { readonly status: "invalid"; readonly issues: readonly DestinationIssue[] }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

/**
 * Saves the submitted values as the draft, publishes its images' derivatives and then
 * the revision itself (seal + public pointer + audit, one transaction).
 */
export async function publishContentDraft<D>(
  spec: ContentKindSpec<D>,
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  repository: ContentRepository,
  imagePublisher: Pick<MediaAdmin, "publish">,
): Promise<PublishContentResult> {
  if (!canPublishContent(membership.role)) return { status: "forbidden" };
  const validation = spec.validate(input);
  if (!validation.ok) return { status: "invalid", issues: validation.issues };
  const missing = spec.publicationIssues(validation.value);
  if (missing.length > 0) return { status: "invalid", issues: missing };

  const saved = await saveContentDraft(
    spec,
    membership,
    contentId,
    validation.value,
    expectedEdit,
    (document) =>
      repository.saveDraft(
        membership.tenantId,
        contentId,
        document as Parameters<ContentRepository["saveDraft"]>[2],
        expectedEdit,
      ),
  );
  if (saved.status !== "saved") return saved;

  await publishContentImages(membership.tenantId, spec.images(validation.value), imagePublisher);

  const outcome = await repository.publish(membership.tenantId, contentId, saved.editCount);
  if (outcome.status !== "invalid") return outcome;
  return {
    status: "invalid",
    issues: outcome.reason === "media" ? [MEDIA_ISSUE] : spec.publicationIssues(validation.value),
  };
}

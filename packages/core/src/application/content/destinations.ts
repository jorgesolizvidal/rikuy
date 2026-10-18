import {
  documentImages,
  publicationIssues,
  validateDestinationDocument,
  type DestinationDocument,
} from "../../contracts/destination";
import type { OrganizationMembership } from "../../contracts/organization";
import type { MediaAdmin } from "../media/ports";
import {
  canEditContent,
  canPublishContent,
  createContent,
  loadContentEditor,
  publishContentDraft,
  saveContentDraft,
  type ContentEditor,
  type ContentKindSpec,
  type CreateContentResult,
  type PublishContentResult,
  type SaveContentResult,
} from "./editing";
import type {
  ContentRepository,
  DestinationListEntry,
  DiscardDraftOutcome,
  RestoreContentOutcome,
} from "./ports";
import { PORTAL_PATHS } from "./portal";

export { canEditContent, canPublishContent, suggestContentSlug } from "./editing";

const DESTINATION: ContentKindSpec<DestinationDocument> = {
  validate: validateDestinationDocument,
  publicationIssues,
  images: documentImages,
};

export function listDestinations(
  membership: OrganizationMembership,
  repository: ContentRepository,
): Promise<DestinationListEntry[]> {
  return repository.listDestinations(membership.tenantId);
}

export type CreateDestinationResult = CreateContentResult;

export function createDestination(
  membership: OrganizationMembership,
  input: { readonly title: unknown; readonly slug: unknown },
  repository: ContentRepository,
): Promise<CreateDestinationResult> {
  return createContent(membership, input, (tenantId, slug, title) =>
    repository.createDestination(tenantId, slug, title),
  );
}

export type DestinationEditor = ContentEditor<DestinationDocument>;

export function loadDestinationEditor(
  membership: OrganizationMembership,
  contentId: string,
  repository: ContentRepository,
): Promise<DestinationEditor | null> {
  return loadContentEditor(
    membership,
    () => repository.findDestination(membership.tenantId, contentId),
    repository,
    PORTAL_PATHS.destination,
  );
}

export type SaveDestinationResult = SaveContentResult;

/** Validates and stores the draft (opening one if the destination has none). */
export function saveDestinationDraft(
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  repository: ContentRepository,
): Promise<SaveDestinationResult> {
  return saveContentDraft(DESTINATION, membership, contentId, input, expectedEdit, (document) =>
    repository.saveDraft(membership.tenantId, contentId, document, expectedEdit),
  );
}

export type PublishDestinationResult = PublishContentResult;

/** Saves, publishes the images' derivatives, then seals and points visitors at it. */
export function publishDestination(
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  repository: ContentRepository,
  imagePublisher: Pick<MediaAdmin, "publish">,
): Promise<PublishDestinationResult> {
  return publishContentDraft(
    DESTINATION,
    membership,
    contentId,
    input,
    expectedEdit,
    repository,
    imagePublisher,
  );
}

/** Puts an earlier sealed revision back in front of visitors (any kind of content). */
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

/** Drops the open draft of published content (any kind). */
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

export const restoreContentRevision = restoreDestinationRevision;
export const discardContentDraft = discardDestinationDraft;

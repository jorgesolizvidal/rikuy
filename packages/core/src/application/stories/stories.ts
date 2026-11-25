import {
  storyPublicationIssues,
  validateStoryDocument,
  type PublishedStory,
  type StoryDocument,
  type StoryIssue,
} from "../../contracts/story";
import type { OrganizationMembership } from "../../contracts/organization";
import type { ContentRecord, DiscardDraftOutcome, RestoreContentOutcome } from "../content/ports";
import {
  canEditContent,
  canPublishContent,
  createContent,
  type CreateContentResult,
} from "../content/editing";
import type {
  RetireStoryOutcome,
  StoryListEntry,
  StoryPlaceOption,
  StoryRepository,
} from "./ports";

/**
 * «Memoria de la comunidad» (ADR-069): stories neighbours tell, loaded by the municipality's
 * team on their behalf. Same flow as destinations (editors prepare, owners and admins
 * publish), plus «Retirar» when the person asks to take it down. Publishing needs the text,
 * who tells it (or «anónimo») and the person's consent.
 */

const ORDER = { draft: 1, changed: 0, published: 0, retired: 2 } as const;

/** Published and changed first, then drafts and retired; by title inside each. */
export async function listStories(
  membership: OrganizationMembership,
  repository: StoryRepository,
): Promise<StoryListEntry[]> {
  const entries = await repository.list(membership.tenantId);
  return [...entries].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.title.localeCompare(b.title, "es"),
  );
}

export function createStory(
  membership: OrganizationMembership,
  input: { readonly title: unknown; readonly slug: unknown },
  repository: StoryRepository,
): Promise<CreateContentResult> {
  return createContent(membership, input, (tenantId, slug, title) =>
    repository.create(tenantId, slug, title),
  );
}

export interface StoryEditor {
  readonly record: ContentRecord<StoryDocument>;
  /** The open draft, else the published revision, else (retired) the last version. */
  readonly document: StoryDocument;
  readonly editCount: number | null;
  readonly retired: boolean;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
  /** The destinations it may be about, by name. */
  readonly places: readonly StoryPlaceOption[];
}

export async function loadStoryEditor(
  membership: OrganizationMembership,
  contentId: string,
  repository: StoryRepository,
): Promise<StoryEditor | null> {
  const [record, places] = await Promise.all([
    repository.find(membership.tenantId, contentId),
    repository.places(membership.tenantId),
  ]);
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
    places: [...places].sort((a, b) => a.title.localeCompare(b.title, "es")),
  };
}

export type SaveStoryResult =
  | { readonly status: "saved"; readonly revisionNo: number; readonly editCount: number }
  | { readonly status: "invalid"; readonly issues: readonly StoryIssue[] }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export async function saveStoryDraft(
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  repository: StoryRepository,
): Promise<SaveStoryResult> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  const validation = validateStoryDocument(input);
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
    issues: [{ path: outcome.reason === "place" ? "placeId" : "", code: "invalid" }],
  };
}

export type PublishStoryResult =
  | { readonly status: "published"; readonly revisionNo: number }
  | { readonly status: "invalid"; readonly issues: readonly StoryIssue[] }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

/** Saves the submitted values as the draft, then publishes it (seal + pointer + audit). */
export async function publishStory(
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  repository: StoryRepository,
): Promise<PublishStoryResult> {
  if (!canPublishContent(membership.role)) return { status: "forbidden" };
  const validation = validateStoryDocument(input);
  if (!validation.ok) return { status: "invalid", issues: validation.issues };
  const missing = storyPublicationIssues(validation.value);
  if (missing.length > 0) return { status: "invalid", issues: missing };

  const saved = await saveStoryDraft(
    membership,
    contentId,
    validation.value,
    expectedEdit,
    repository,
  );
  if (saved.status !== "saved") return saved;
  const outcome = await repository.publish(membership.tenantId, contentId, saved.editCount);
  if (outcome.status !== "invalid") return outcome;
  return {
    status: "invalid",
    issues: [
      outcome.reason === "consent"
        ? { path: "consent", code: "required" }
        : { path: "body", code: "required" },
    ],
  };
}

export function retireStory(
  membership: OrganizationMembership,
  contentId: string,
  repository: StoryRepository,
): Promise<RetireStoryOutcome> {
  if (!canPublishContent(membership.role)) return Promise.resolve({ status: "forbidden" });
  return repository.retire(membership.tenantId, contentId);
}

export function restoreStoryRevision(
  membership: OrganizationMembership,
  contentId: string,
  revisionId: unknown,
  repository: StoryRepository,
): Promise<RestoreContentOutcome> {
  if (!canPublishContent(membership.role)) return Promise.resolve({ status: "forbidden" });
  if (typeof revisionId !== "string" || revisionId === "") {
    return Promise.resolve({ status: "not_found" });
  }
  return repository.restore(membership.tenantId, contentId, revisionId);
}

export function discardStoryDraft(
  membership: OrganizationMembership,
  contentId: string,
  expectedEdit: unknown,
  repository: StoryRepository,
): Promise<DiscardDraftOutcome> {
  if (!canEditContent(membership.role)) return Promise.resolve({ status: "forbidden" });
  if (typeof expectedEdit !== "number" || !Number.isInteger(expectedEdit)) {
    return Promise.resolve({ status: "conflict" });
  }
  return repository.discardDraft(membership.tenantId, contentId, expectedEdit);
}

/** The stories about one destination, for its page («Lo que cuenta la comunidad»). */
export function storiesOfPlace(
  stories: readonly PublishedStory[],
  placeSlug: string,
): PublishedStory[] {
  return stories.filter((story) => story.place?.slug === placeSlug);
}

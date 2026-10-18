import {
  eventImages,
  eventPublicationIssues,
  validateEventDocument,
  type EventDocument,
} from "../../contracts/event";
import type { OrganizationMembership } from "../../contracts/organization";
import type { MediaAdmin } from "../media/ports";
import {
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
import type { ContentRepository, EventListEntry } from "./ports";
import { PORTAL_PATHS } from "./portal";

/**
 * Events (one occurrence). Same editorial flow as destinations; the database turns the
 * local schedule into instants with the municipality's time zone and drops ended events
 * from the public agenda on its own.
 */

const EVENT: ContentKindSpec<EventDocument> = {
  validate: validateEventDocument,
  publicationIssues: eventPublicationIssues,
  images: eventImages,
};

export interface Agenda {
  /** Not over yet, soonest first. */
  readonly upcoming: EventListEntry[];
  /** Drafts without a date yet. */
  readonly undated: EventListEntry[];
  /** Over, most recent first. */
  readonly past: EventListEntry[];
}

export async function loadAgenda(
  membership: OrganizationMembership,
  repository: ContentRepository,
): Promise<Agenda> {
  const entries = await repository.listEvents(membership.tenantId);
  const byStart = (a: EventListEntry, b: EventListEntry) =>
    (a.schedule?.start ?? "").localeCompare(b.schedule?.start ?? "") ||
    a.title.localeCompare(b.title, "es");
  return {
    upcoming: entries.filter((entry) => entry.schedule && !entry.ended).sort(byStart),
    undated: entries
      .filter((entry) => entry.schedule === null)
      .sort((a, b) => a.title.localeCompare(b.title, "es")),
    past: entries.filter((entry) => entry.schedule && entry.ended).sort((a, b) => byStart(b, a)),
  };
}

export function createEvent(
  membership: OrganizationMembership,
  input: { readonly title: unknown; readonly slug: unknown },
  repository: ContentRepository,
): Promise<CreateContentResult> {
  return createContent(membership, input, (tenantId, slug, title) =>
    repository.createEvent(tenantId, slug, title),
  );
}

export type EventEditor = ContentEditor<EventDocument>;

export function loadEventEditor(
  membership: OrganizationMembership,
  contentId: string,
  repository: ContentRepository,
): Promise<EventEditor | null> {
  return loadContentEditor(
    membership,
    () => repository.findEvent(membership.tenantId, contentId),
    repository,
    PORTAL_PATHS.event,
  );
}

export function saveEventDraft(
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  repository: ContentRepository,
): Promise<SaveContentResult> {
  return saveContentDraft(EVENT, membership, contentId, input, expectedEdit, (document) =>
    repository.saveDraft(membership.tenantId, contentId, document, expectedEdit),
  );
}

export function publishEvent(
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  repository: ContentRepository,
  imagePublisher: Pick<MediaAdmin, "publish">,
): Promise<PublishContentResult> {
  return publishContentDraft(
    EVENT,
    membership,
    contentId,
    input,
    expectedEdit,
    repository,
    imagePublisher,
  );
}

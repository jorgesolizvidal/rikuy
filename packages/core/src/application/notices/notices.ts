import {
  validateNoticeDocument,
  type NoticeDocument,
  type NoticeIssue,
} from "../../contracts/notice";
import type { OrganizationMembership } from "../../contracts/organization";
import {
  noticePublicationIssues,
  noticeState,
  type NoticeState,
} from "../../domain/notices/validity";
import type { ContentRecord, DiscardDraftOutcome, RestoreContentOutcome } from "../content/ports";
import {
  canEditContent,
  canPublishContent,
  createContent,
  type CreateContentResult,
} from "../content/editing";
import type {
  NoticeListEntry,
  NoticePlaceOption,
  NoticeRepository,
  RetireNoticeOutcome,
} from "./ports";

/**
 * «Avisos» (ADR-069): what changes in the municipality, with an end. Same flow as destinations
 * (editors prepare, owners and admins publish), plus «Retirar»; the validity is checked against
 * the municipality's clock here and again by the database.
 */

/** How the panel names a notice's state, from its status and its published validity. */
export type NoticeListState = "draft" | "scheduled" | "active" | "expired" | "retired";

export interface NoticeRow extends NoticeListEntry {
  readonly state: NoticeListState;
  /** It has an open draft on top of what visitors see. */
  readonly changed: boolean;
}

export function noticeListState(
  entry: NoticeListEntry,
  now: Date,
  timezone: string,
): NoticeListState {
  if (entry.status === "draft") return "draft";
  if (entry.status === "retired" || entry.published === null) return "retired";
  const state: NoticeState = noticeState(entry.published, now, timezone);
  return state === "incomplete" ? "expired" : state;
}

const ORDER: Record<NoticeListState, number> = {
  active: 0,
  scheduled: 1,
  draft: 2,
  expired: 3,
  retired: 4,
};

/** In force first, then programmed, drafts, ended and retired; newest first inside each. */
export async function listNotices(
  membership: OrganizationMembership,
  now: Date,
  repository: NoticeRepository,
): Promise<NoticeRow[]> {
  const [entries, timezone] = await Promise.all([
    repository.list(membership.tenantId),
    repository.timezone(membership.tenantId),
  ]);
  return entries
    .map((entry) => ({
      ...entry,
      state: noticeListState(entry, now, timezone),
      changed: entry.status === "changed",
    }))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.updatedAt.localeCompare(a.updatedAt));
}

export function createNotice(
  membership: OrganizationMembership,
  input: { readonly title: unknown; readonly slug: unknown },
  repository: NoticeRepository,
): Promise<CreateContentResult> {
  return createContent(membership, input, (tenantId, slug, title) =>
    repository.create(tenantId, slug, title),
  );
}

export interface NoticeEditor {
  readonly record: ContentRecord<NoticeDocument>;
  /** The open draft, else the published revision, else (retired) the last version. */
  readonly document: NoticeDocument;
  readonly editCount: number | null;
  readonly retired: boolean;
  /** Where the published version stands now (null when not published). */
  readonly publishedState: NoticeState | null;
  readonly places: readonly NoticePlaceOption[];
  readonly timezone: string;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
}

export async function loadNoticeEditor(
  membership: OrganizationMembership,
  contentId: string,
  now: Date,
  repository: NoticeRepository,
): Promise<NoticeEditor | null> {
  const [record, places, timezone] = await Promise.all([
    repository.find(membership.tenantId, contentId),
    repository.places(membership.tenantId),
    repository.timezone(membership.tenantId),
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
    publishedState: record.published
      ? noticeState(record.published.document.validity, now, timezone)
      : null,
    places,
    timezone,
    canEdit: canEditContent(membership.role),
    canPublish: canPublishContent(membership.role),
  };
}

export type SaveNoticeResult =
  | { readonly status: "saved"; readonly revisionNo: number; readonly editCount: number }
  | { readonly status: "invalid"; readonly issues: readonly NoticeIssue[] }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export async function saveNoticeDraft(
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  repository: NoticeRepository,
): Promise<SaveNoticeResult> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  const validation = validateNoticeDocument(input);
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
    issues: [
      outcome.reason === "place"
        ? { path: "placeId", code: "place" }
        : { path: "", code: "invalid" },
    ],
  };
}

export type PublishNoticeResult =
  | { readonly status: "published"; readonly revisionNo: number }
  | { readonly status: "invalid"; readonly issues: readonly NoticeIssue[] }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

/** Saves the submitted values as the draft, then publishes it (seal + pointer + audit). */
export async function publishNotice(
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  now: Date,
  repository: NoticeRepository,
): Promise<PublishNoticeResult> {
  if (!canPublishContent(membership.role)) return { status: "forbidden" };
  const validation = validateNoticeDocument(input);
  if (!validation.ok) return { status: "invalid", issues: validation.issues };
  const timezone = await repository.timezone(membership.tenantId);
  const missing = noticePublicationIssues(validation.value, now, timezone);
  if (missing.length > 0) return { status: "invalid", issues: missing };

  const saved = await saveNoticeDraft(
    membership,
    contentId,
    validation.value,
    expectedEdit,
    repository,
  );
  if (saved.status !== "saved") return saved;
  const outcome = await repository.publish(membership.tenantId, contentId, saved.editCount);
  if (outcome.status !== "invalid") return outcome;
  // The database's clock decided it (a minute passed, or another time zone rule).
  const issues = noticePublicationIssues(validation.value, now, timezone);
  return {
    status: "invalid",
    issues:
      issues.length > 0
        ? issues
        : [
            outcome.reason === "validity"
              ? { path: "validity.until", code: "past" }
              : { path: "summary", code: "required" },
          ],
  };
}

export function retireNotice(
  membership: OrganizationMembership,
  contentId: string,
  repository: NoticeRepository,
): Promise<RetireNoticeOutcome> {
  if (!canPublishContent(membership.role)) return Promise.resolve({ status: "forbidden" });
  return repository.retire(membership.tenantId, contentId);
}

export function restoreNoticeRevision(
  membership: OrganizationMembership,
  contentId: string,
  revisionId: unknown,
  repository: NoticeRepository,
): Promise<RestoreContentOutcome> {
  if (!canPublishContent(membership.role)) return Promise.resolve({ status: "forbidden" });
  if (typeof revisionId !== "string" || revisionId === "") {
    return Promise.resolve({ status: "not_found" });
  }
  return repository.restore(membership.tenantId, contentId, revisionId);
}

export function discardNoticeDraft(
  membership: OrganizationMembership,
  contentId: string,
  expectedEdit: unknown,
  repository: NoticeRepository,
): Promise<DiscardDraftOutcome> {
  if (!canEditContent(membership.role)) return Promise.resolve({ status: "forbidden" });
  if (typeof expectedEdit !== "number" || !Number.isInteger(expectedEdit)) {
    return Promise.resolve({ status: "conflict" });
  }
  return repository.discardDraft(membership.tenantId, contentId, expectedEdit);
}

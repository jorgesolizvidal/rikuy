import type { DestinationIssue } from "../../contracts/destination";
import { knowledgeDocumentSchema, type KnowledgeDocument } from "../../contracts/knowledge";
import type { OrganizationMembership } from "../../contracts/organization";
import type { ContentRecord, DiscardDraftOutcome, RestoreContentOutcome } from "../content/ports";
import {
  canEditContent,
  canPublishContent,
  createContent,
  type CreateContentResult,
} from "../content/editing";
import type {
  DocumentVersionView,
  KnowledgeListEntry,
  KnowledgeRepository,
  RetireKnowledgeOutcome,
} from "./ports";

/**
 * «Conocimiento del asistente» (ADR-037): texts and documents a municipality publishes for
 * the assistant only. Same flow as destinations, plus «Retirar».
 */

export function validateKnowledgeDocument(
  input: unknown,
):
  | { readonly ok: true; readonly value: KnowledgeDocument }
  | { readonly ok: false; readonly issues: readonly DestinationIssue[] } {
  const parsed = knowledgeDocumentSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      code: "invalid" as const,
    })),
  };
}

/** What a draft still needs: something for the assistant to read. */
export function knowledgePublicationIssues(document: KnowledgeDocument): DestinationIssue[] {
  return document.body.length === 0 && document.document === null
    ? [{ path: "body", code: "required" }]
    : [];
}

export function listKnowledge(
  membership: OrganizationMembership,
  repository: KnowledgeRepository,
): Promise<KnowledgeListEntry[]> {
  return repository.list(membership.tenantId);
}

export function createKnowledge(
  membership: OrganizationMembership,
  input: { readonly title: unknown; readonly slug: unknown },
  repository: KnowledgeRepository,
): Promise<CreateContentResult> {
  return createContent(membership, input, (tenantId, slug, title) =>
    repository.create(tenantId, slug, title),
  );
}

export interface KnowledgeEditor {
  readonly record: ContentRecord<KnowledgeDocument>;
  /** The open draft, else the published revision, else (retired) the last version. */
  readonly document: KnowledgeDocument;
  readonly editCount: number | null;
  readonly retired: boolean;
  /** The document the form shows, with its reading state. */
  readonly attachment: DocumentVersionView | null;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
}

export async function loadKnowledgeEditor(
  membership: OrganizationMembership,
  contentId: string,
  repository: KnowledgeRepository,
): Promise<KnowledgeEditor | null> {
  const record = await repository.find(membership.tenantId, contentId);
  if (record === null) return null;
  const last = record.history[0];
  const document =
    record.draft?.document ??
    record.published?.document ??
    (last ? await repository.revisionDocument(membership.tenantId, last.revisionId) : null);
  if (!document) return null;
  const attachment = document.document
    ? await repository.findDocument(
        membership.tenantId,
        document.document.assetId,
        document.document.version,
      )
    : null;
  return {
    record,
    document,
    editCount: record.draft?.editCount ?? null,
    retired: record.published === null && record.history.length > 0,
    attachment,
    canEdit: canEditContent(membership.role),
    canPublish: canPublishContent(membership.role),
  };
}

export type SaveKnowledgeResult =
  | { readonly status: "saved"; readonly revisionNo: number; readonly editCount: number }
  | { readonly status: "invalid"; readonly issues: readonly DestinationIssue[] }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export async function saveKnowledgeDraft(
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  repository: KnowledgeRepository,
): Promise<SaveKnowledgeResult> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  const validation = validateKnowledgeDocument(input);
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
    issues: [{ path: outcome.reason === "document" ? "document" : "", code: "invalid" }],
  };
}

export type PublishKnowledgeResult =
  | { readonly status: "published"; readonly revisionNo: number }
  | { readonly status: "invalid"; readonly issues: readonly DestinationIssue[] }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

/** Saves the submitted values as the draft, then publishes it (seal + pointer + audit). */
export async function publishKnowledge(
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  repository: KnowledgeRepository,
): Promise<PublishKnowledgeResult> {
  if (!canPublishContent(membership.role)) return { status: "forbidden" };
  const validation = validateKnowledgeDocument(input);
  if (!validation.ok) return { status: "invalid", issues: validation.issues };
  const missing = knowledgePublicationIssues(validation.value);
  if (missing.length > 0) return { status: "invalid", issues: missing };

  const saved = await saveKnowledgeDraft(
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
    issues:
      outcome.reason === "document"
        ? [{ path: "document", code: "media" }]
        : knowledgePublicationIssues(validation.value),
  };
}

export function retireKnowledge(
  membership: OrganizationMembership,
  contentId: string,
  repository: KnowledgeRepository,
): Promise<RetireKnowledgeOutcome> {
  if (!canPublishContent(membership.role)) return Promise.resolve({ status: "forbidden" });
  return repository.retire(membership.tenantId, contentId);
}

export function restoreKnowledgeRevision(
  membership: OrganizationMembership,
  contentId: string,
  revisionId: unknown,
  repository: KnowledgeRepository,
): Promise<RestoreContentOutcome> {
  if (!canPublishContent(membership.role)) return Promise.resolve({ status: "forbidden" });
  if (typeof revisionId !== "string" || revisionId === "") {
    return Promise.resolve({ status: "not_found" });
  }
  return repository.restore(membership.tenantId, contentId, revisionId);
}

export function discardKnowledgeDraft(
  membership: OrganizationMembership,
  contentId: string,
  expectedEdit: unknown,
  repository: KnowledgeRepository,
): Promise<DiscardDraftOutcome> {
  if (!canEditContent(membership.role)) return Promise.resolve({ status: "forbidden" });
  if (typeof expectedEdit !== "number" || !Number.isInteger(expectedEdit)) {
    return Promise.resolve({ status: "conflict" });
  }
  return repository.discardDraft(membership.tenantId, contentId, expectedEdit);
}

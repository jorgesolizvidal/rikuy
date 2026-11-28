import {
  FAQ_TOPICS,
  FAQ_TOPIC_NAMES,
  faqPublicationIssues,
  validateFaqDocument,
  type FaqDocument,
  type FaqIssue,
  type FaqTopic,
  type PublishedFaq,
} from "../../contracts/faq";
import type { OrganizationMembership } from "../../contracts/organization";
import { richTextToPlainText } from "../../contracts/rich-text";
import type { ContentRecord, DiscardDraftOutcome, RestoreContentOutcome } from "../content/ports";
import {
  canEditContent,
  canPublishContent,
  createContent,
  type CreateContentResult,
} from "../content/editing";
import type { FaqListEntry, FaqPlaceOption, FaqRepository, RetireFaqOutcome } from "./ports";

/**
 * «Preguntas frecuentes» (A · Paso 5.2, ADR-074): the questions visitors ask, answered by the
 * municipality's team. Same flow as destinations (editors prepare, owners and admins publish),
 * plus «Retirar» when an answer no longer applies. Publishing needs the answer.
 */

const ORDER = { draft: 1, changed: 0, published: 0, retired: 2 } as const;

/** Published and changed first, then drafts and retired; by topic and question inside each. */
export async function listFaqs(
  membership: OrganizationMembership,
  repository: FaqRepository,
): Promise<FaqListEntry[]> {
  const entries = await repository.list(membership.tenantId);
  return [...entries].sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      FAQ_TOPICS.indexOf(a.topic) - FAQ_TOPICS.indexOf(b.topic) ||
      a.question.localeCompare(b.question, "es"),
  );
}

export function createFaq(
  membership: OrganizationMembership,
  input: { readonly title: unknown; readonly slug: unknown },
  repository: FaqRepository,
): Promise<CreateContentResult> {
  return createContent(membership, input, (tenantId, slug, title) =>
    repository.create(tenantId, slug, title),
  );
}

export interface FaqEditor {
  readonly record: ContentRecord<FaqDocument>;
  /** The open draft, else the published revision, else (retired) the last version. */
  readonly document: FaqDocument;
  readonly editCount: number | null;
  readonly retired: boolean;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
  /** The destinations and events it may be about, by name. */
  readonly places: readonly FaqPlaceOption[];
}

export async function loadFaqEditor(
  membership: OrganizationMembership,
  contentId: string,
  repository: FaqRepository,
): Promise<FaqEditor | null> {
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

export type SaveFaqResult =
  | { readonly status: "saved"; readonly revisionNo: number; readonly editCount: number }
  | { readonly status: "invalid"; readonly issues: readonly FaqIssue[] }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export async function saveFaqDraft(
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  repository: FaqRepository,
): Promise<SaveFaqResult> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  const validation = validateFaqDocument(input);
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

export type PublishFaqResult =
  | { readonly status: "published"; readonly revisionNo: number }
  | { readonly status: "invalid"; readonly issues: readonly FaqIssue[] }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

/** Saves the submitted values as the draft, then publishes it (seal + pointer + audit). */
export async function publishFaq(
  membership: OrganizationMembership,
  contentId: string,
  input: unknown,
  expectedEdit: number | null,
  repository: FaqRepository,
): Promise<PublishFaqResult> {
  if (!canPublishContent(membership.role)) return { status: "forbidden" };
  const validation = validateFaqDocument(input);
  if (!validation.ok) return { status: "invalid", issues: validation.issues };
  const missing = faqPublicationIssues(validation.value);
  if (missing.length > 0) return { status: "invalid", issues: missing };

  const saved = await saveFaqDraft(
    membership,
    contentId,
    validation.value,
    expectedEdit,
    repository,
  );
  if (saved.status !== "saved") return saved;
  const outcome = await repository.publish(membership.tenantId, contentId, saved.editCount);
  if (outcome.status !== "invalid") return outcome;
  return { status: "invalid", issues: [{ path: "summary", code: "required" }] };
}

export function retireFaq(
  membership: OrganizationMembership,
  contentId: string,
  repository: FaqRepository,
): Promise<RetireFaqOutcome> {
  if (!canPublishContent(membership.role)) return Promise.resolve({ status: "forbidden" });
  return repository.retire(membership.tenantId, contentId);
}

export function restoreFaqRevision(
  membership: OrganizationMembership,
  contentId: string,
  revisionId: unknown,
  repository: FaqRepository,
): Promise<RestoreContentOutcome> {
  if (!canPublishContent(membership.role)) return Promise.resolve({ status: "forbidden" });
  if (typeof revisionId !== "string" || revisionId === "") {
    return Promise.resolve({ status: "not_found" });
  }
  return repository.restore(membership.tenantId, contentId, revisionId);
}

export function discardFaqDraft(
  membership: OrganizationMembership,
  contentId: string,
  expectedEdit: unknown,
  repository: FaqRepository,
): Promise<DiscardDraftOutcome> {
  if (!canEditContent(membership.role)) return Promise.resolve({ status: "forbidden" });
  if (typeof expectedEdit !== "number" || !Number.isInteger(expectedEdit)) {
    return Promise.resolve({ status: "conflict" });
  }
  return repository.discardDraft(membership.tenantId, contentId, expectedEdit);
}

// ── The portal ──────────────────────────────────────────────────────────────

export interface FaqGroup {
  readonly topic: FaqTopic;
  readonly name: string;
  readonly faqs: readonly PublishedFaq[];
}

/** The questions by topic, in the platform's order; topics without questions left out. */
export function groupFaqs(faqs: readonly PublishedFaq[]): FaqGroup[] {
  return FAQ_TOPICS.map((topic) => ({
    topic,
    name: FAQ_TOPIC_NAMES[topic],
    faqs: faqs.filter((faq) => faq.topic === topic),
  })).filter((group) => group.faqs.length > 0);
}

/** The questions about one destination or event, for its page. */
export function faqsOfPlace(
  faqs: readonly PublishedFaq[],
  place: { readonly kind: "destination" | "event"; readonly slug: string },
): PublishedFaq[] {
  return faqs.filter((faq) => faq.place?.kind === place.kind && faq.place.slug === place.slug);
}

/** schema.org FAQPage for search engines (serialized safely by the caller). */
export function faqPageJsonLd(
  faqs: readonly PublishedFaq[],
  options: { readonly url: string; readonly portalName: string },
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    url: options.url,
    isPartOf: { "@type": "WebSite", name: options.portalName },
    mainEntity: faqs.map((faq) => {
      const details = richTextToPlainText(faq.body);
      return {
        "@type": "Question",
        name: faq.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: details ? `${faq.answer}\n\n${details}` : faq.answer,
        },
      };
    }),
  };
}

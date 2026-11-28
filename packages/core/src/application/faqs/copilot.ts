import { FAQ_LIMITS, type FaqTopic } from "../../contracts/faq";
import type { CopilotSourceLink } from "../../contracts/copilot";
import type { OrganizationMembership } from "../../contracts/organization";
import { parseFaqProposal } from "../../domain/copilot/parse";
import { copilotFaqMessages } from "../../domain/copilot/prompts";
import { hasModule, passageVisibleWith } from "../../domain/tenancy/modules";
import { reservationFor } from "../ai/gateway";
import {
  canPropose,
  COPILOT_NOTICES,
  passageSourceLink,
  type CopilotAiRunner,
} from "../copilot/copilot";
import type { KnowledgeRepository } from "../knowledge/ports";
import { createFaq, saveFaqDraft } from "./faqs";
import type { FaqRepository } from "./ports";

/**
 * «Crear pregunta frecuente con el Copilot» (A · Paso 5.2, ADR-074): from a question visitors
 * asked, the Copilot proposes the question and an answer taken ONLY from what is published,
 * with its sources. When nothing published answers it, it proposes only the question (without
 * asking the model: nothing to read, no quota spent) and the team writes the answer. Nothing is
 * saved until the team accepts it, and then only as a DRAFT: never published by the Copilot.
 */

const PASSAGES = 4;

export type FaqProposalResult =
  | {
      readonly status: "proposed";
      readonly question: string;
      /** Null when nothing published answers it: the team writes it. */
      readonly answer: string | null;
      readonly topic: FaqTopic;
      readonly sources: readonly CopilotSourceLink[];
    }
  | { readonly status: "notice"; readonly message: string }
  | { readonly status: "invalid" | "forbidden" };

export interface FaqProposalDeps {
  readonly knowledge: KnowledgeRepository;
  readonly ai: CopilotAiRunner;
}

function cleanQuestion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return line.length >= 3 && line.length <= FAQ_LIMITS.question ? line : null;
}

export async function proposeFaq(
  membership: OrganizationMembership,
  actorId: string,
  input: { readonly question: unknown },
  deps: FaqProposalDeps,
): Promise<FaqProposalResult> {
  if (!canPropose(membership) || !hasModule(membership.modules, "copilot")) {
    return { status: "forbidden" };
  }
  const question = cleanQuestion(input.question);
  if (question === null) return { status: "invalid" };

  const found = await deps.knowledge.search(membership.tenantId, question, PASSAGES * 2);
  const passages = found
    .filter((passage) => passageVisibleWith(membership.modules, passage))
    .slice(0, PASSAGES);
  if (passages.length === 0) {
    return { status: "proposed", question, answer: null, topic: "other", sources: [] };
  }

  const messages = copilotFaqMessages({ site: membership.displayName, question, passages });
  const result = await deps.ai(
    {
      tenantId: membership.tenantId,
      profile: "copilot",
      reserveTokens: reservationFor("copilot", messages),
      actorId,
    },
    async (call) => (await call({ messages })).text,
  );
  if (result.outcome !== "answered") {
    return { status: "notice", message: COPILOT_NOTICES[result.outcome] };
  }
  const parsed = parseFaqProposal(result.value);
  // Only the passages it says it used, and only ones that exist: an answer without a
  // published source is not an answer (the team writes it).
  const used = parsed.labels
    .filter((label) => label.startsWith("F"))
    .map((label) => passages[Number(label.slice(1)) - 1])
    .filter((passage) => passage !== undefined);
  const sources: CopilotSourceLink[] = [];
  for (const passage of used) {
    const link = passageSourceLink(membership.slug, passage);
    if (!sources.some((known) => known.href === link.href && known.title === link.title)) {
      sources.push(link);
    }
  }
  const answer = sources.length > 0 ? parsed.answer : null;
  return {
    status: "proposed",
    question: parsed.question ?? question,
    answer,
    topic: parsed.topic ?? "other",
    sources: answer === null ? [] : sources,
  };
}

export type CreateFaqDraftResult =
  | { readonly status: "created"; readonly contentId: string }
  | { readonly status: "invalid" | "slug_taken" | "forbidden" | "error" };

/**
 * «Crear el borrador»: the question (and the answer, if any) as a new question's DRAFT, as the
 * person (the RPCs check the role again). Never published here.
 */
export async function createFaqDraft(
  membership: OrganizationMembership,
  input: { readonly question: unknown; readonly answer: unknown; readonly topic: unknown },
  repository: FaqRepository,
): Promise<CreateFaqDraftResult> {
  const question = cleanQuestion(input.question);
  if (question === null) return { status: "invalid" };
  const answer = typeof input.answer === "string" ? input.answer.replace(/\s+/gu, " ").trim() : "";
  const created = await createFaq(membership, { title: question, slug: "" }, repository);
  if (created.status !== "created") {
    return created.status === "invalid" ? { status: "invalid" } : { status: created.status };
  }
  const record = await repository.find(membership.tenantId, created.contentId);
  const saved = await saveFaqDraft(
    membership,
    created.contentId,
    { title: question, summary: answer, body: [], topic: input.topic, placeId: null },
    record?.draft?.editCount ?? null,
    repository,
  );
  // The question exists either way: the editor opens with whatever was saved.
  return saved.status === "saved" || saved.status === "invalid" || saved.status === "conflict"
    ? { status: "created", contentId: created.contentId }
    : { status: saved.status === "forbidden" ? "forbidden" : "error" };
}

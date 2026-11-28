"use server";

import {
  createFaq,
  createFaqDraft,
  discardFaqDraft,
  openOrganization,
  parseMarkup,
  proposeFaq,
  publishFaq,
  retireFaq,
  saveFaqDraft,
  type CreateFaqDraftResult,
  type FaqIssue,
  type FaqProposalResult,
  type OrganizationMembership,
} from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { runAiWork } from "@/server/ai-gateway";
import { refreshPortal } from "@/server/portal-cache";

/*
 * «Preguntas frecuentes» (ADR-074). Every action re-opens the organization with the CURRENT
 * membership, calls one use case and returns state; the browser navigates or refreshes itself
 * (no redirects inside Server Actions, CONTRIBUTING §1.2). Every municipality has them (no
 * module, like the notices). Whatever visitors see changes (publish, retire), the
 * municipality's portal pages are refreshed: the questions are on `/preguntas-frecuentes`, on
 * their place's page and in the footer.
 */

type SessionProblem = { readonly status: "signed_out" | "forbidden" };

async function context(
  slug: unknown,
): Promise<
  | { membership: OrganizationMembership; session: Awaited<ReturnType<typeof adminSession>> }
  | SessionProblem
> {
  const actor = await currentAdminActor();
  if (actor === null) return { status: "signed_out" };
  const session = await adminSession();
  const membership =
    typeof slug === "string" ? await openOrganization(actor, slug, session.memberships) : null;
  return membership === null ? { status: "forbidden" } : { membership, session };
}

async function refresh(
  session: Awaited<ReturnType<typeof adminSession>>,
  membership: OrganizationMembership,
): Promise<void> {
  await refreshPortal((tenantId) => session.content.portalHostname(tenantId), membership.tenantId);
}

// ── New question ────────────────────────────────────────────────────────────────

export interface CreateFaqState {
  readonly status:
    "idle" | "created" | "invalid_title" | "slug_taken" | "forbidden" | "signed_out" | "error";
  readonly contentId?: string;
}

export async function createFaqAction(
  _previous: CreateFaqState,
  formData: FormData,
): Promise<CreateFaqState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const result = await createFaq(
      access.membership,
      { title: formData.get("title"), slug: "" },
      access.session.faqs,
    );
    switch (result.status) {
      case "created":
        return { status: "created", contentId: result.contentId };
      case "invalid":
        return { status: "invalid_title" };
      default:
        return { status: result.status };
    }
  } catch {
    return { status: "error" };
  }
}

// ── Save, publish, retire, discard ──────────────────────────────────────────

export interface FaqPayload {
  readonly org: string;
  readonly contentId: string;
  readonly intent: "save" | "publish";
  readonly expectedEdit: number | null;
  /** The question. */
  readonly title: string;
  /** The short answer. */
  readonly summary: string;
  /** «Más detalles» as written in the editor (the limited Markdown of destinations). */
  readonly markup: string;
  readonly topic: string;
  readonly placeId: string | null;
}

export interface SaveFaqState {
  readonly status:
    | "idle"
    | "saved"
    | "published"
    | "invalid"
    | "conflict"
    | "forbidden"
    | "not_found"
    | "signed_out"
    | "error";
  readonly editCount: number | null;
  readonly revisionNo?: number;
  readonly issues?: readonly FaqIssue[];
}

export async function saveFaqAction(
  previous: Pick<SaveFaqState, "status" | "editCount">,
  payload: FaqPayload,
): Promise<SaveFaqState> {
  try {
    const access = await context(payload?.org);
    if (!("membership" in access)) return { ...access, editCount: previous.editCount };
    const parsed = parseMarkup(typeof payload.markup === "string" ? payload.markup : "");
    if (parsed.problems.length > 0) {
      return {
        status: "invalid",
        editCount: previous.editCount,
        issues: [{ path: "body", code: "invalid" }],
      };
    }
    // The use case validates every field: the payload goes as it came.
    const document = {
      title: payload.title,
      summary: payload.summary,
      body: parsed.blocks,
      topic: payload.topic,
      placeId: payload.placeId,
    };
    const expected = typeof payload.expectedEdit === "number" ? payload.expectedEdit : null;
    const repository = access.session.faqs;
    if (payload.intent === "publish") {
      const result = await publishFaq(
        access.membership,
        payload.contentId,
        document,
        expected,
        repository,
      );
      if (result.status === "published") {
        await refresh(access.session, access.membership);
        return { status: "published", editCount: null, revisionNo: result.revisionNo };
      }
      return result.status === "invalid"
        ? { status: "invalid", editCount: previous.editCount, issues: result.issues }
        : { status: result.status, editCount: previous.editCount };
    }
    const result = await saveFaqDraft(
      access.membership,
      payload.contentId,
      document,
      expected,
      repository,
    );
    if (result.status === "saved") {
      return { status: "saved", editCount: result.editCount, revisionNo: result.revisionNo };
    }
    return result.status === "invalid"
      ? { status: "invalid", editCount: previous.editCount, issues: result.issues }
      : { status: result.status, editCount: previous.editCount };
  } catch {
    return { status: "error", editCount: previous.editCount };
  }
}

export interface FaqActionState {
  readonly status:
    | "idle"
    | "retired"
    | "discarded"
    | "never_published"
    | "conflict"
    | "forbidden"
    | "not_found"
    | "signed_out"
    | "error";
}

export async function retireFaqAction(
  _previous: FaqActionState,
  formData: FormData,
): Promise<FaqActionState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const contentId = formData.get("contentId");
    if (typeof contentId !== "string") return { status: "not_found" };
    const result = await retireFaq(access.membership, contentId, access.session.faqs);
    if (result.status === "retired") await refresh(access.session, access.membership);
    return result;
  } catch {
    return { status: "error" };
  }
}

export async function discardFaqAction(
  _previous: FaqActionState,
  formData: FormData,
): Promise<FaqActionState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const contentId = formData.get("contentId");
    if (typeof contentId !== "string") return { status: "not_found" };
    return await discardFaqDraft(
      access.membership,
      contentId,
      Number(formData.get("expectedEdit")),
      access.session.faqs,
    );
  } catch {
    return { status: "error" };
  }
}

// ── «Crear pregunta frecuente con el Copilot» ───────────────────────────────

export type ProposeFaqState =
  FaqProposalResult | { readonly status: "idle" | "signed_out" | "error" };

export async function proposeFaqAction(input: {
  readonly org: string;
  readonly question: string;
}): Promise<ProposeFaqState> {
  try {
    const access = await context(input?.org);
    if (!("membership" in access)) return access;
    const actor = await currentAdminActor();
    if (actor === null) return { status: "signed_out" };
    return await proposeFaq(
      access.membership,
      actor.userId,
      { question: input.question },
      { knowledge: access.session.knowledge, ai: (request, work) => runAiWork(request, work) },
    );
  } catch {
    return { status: "error" };
  }
}

export type CreateFaqDraftState = CreateFaqDraftResult | { readonly status: "idle" | "signed_out" };

export async function createFaqDraftAction(input: {
  readonly org: string;
  readonly question: string;
  readonly answer: string;
  readonly topic: string;
}): Promise<CreateFaqDraftState> {
  try {
    const access = await context(input?.org);
    if (!("membership" in access)) return access;
    return await createFaqDraft(
      access.membership,
      { question: input.question, answer: input.answer, topic: input.topic },
      access.session.faqs,
    );
  } catch {
    return { status: "error" };
  }
}

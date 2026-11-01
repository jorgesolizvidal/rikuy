"use server";

import {
  createKnowledge,
  discardKnowledgeDraft,
  openOrganization,
  parseMarkup,
  publicCitation,
  publishKnowledge,
  requestDocumentUpload,
  retireKnowledge,
  saveKnowledgeDraft,
  searchKnowledge,
  submitDocument,
  type DestinationIssue,
  type DocumentSubmitOutcome,
  type DocumentVersionView,
  type OrganizationMembership,
  type PublicCitation,
  type RequestDocumentUploadResult,
} from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";

/*
 * «Conocimiento del asistente» (ADR-037). Every action re-opens the organization with the
 * CURRENT membership, calls one use case and returns state; the browser navigates or
 * refreshes itself (no redirects inside Server Actions, CONTRIBUTING §1.2). Knowledge is
 * only for the assistant: no portal page to refresh.
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

// ── New item ────────────────────────────────────────────────────────────────

export interface CreateKnowledgeState {
  readonly status:
    "idle" | "created" | "invalid_title" | "slug_taken" | "forbidden" | "signed_out" | "error";
  readonly contentId?: string;
}

export async function createKnowledgeAction(
  _previous: CreateKnowledgeState,
  formData: FormData,
): Promise<CreateKnowledgeState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const result = await createKnowledge(
      access.membership,
      { title: formData.get("title"), slug: "" },
      access.session.knowledge,
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

export interface KnowledgePayload {
  readonly org: string;
  readonly contentId: string;
  readonly intent: "save" | "publish";
  readonly expectedEdit: number | null;
  readonly title: string;
  readonly summary: string;
  readonly markup: string;
  readonly document: { readonly assetId: string; readonly version: number } | null;
}

export interface SaveKnowledgeState {
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
  readonly issues?: readonly DestinationIssue[];
}

export async function saveKnowledgeAction(
  previous: Pick<SaveKnowledgeState, "status" | "editCount">,
  payload: KnowledgePayload,
): Promise<SaveKnowledgeState> {
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
    const document = {
      title: payload.title,
      summary: payload.summary,
      body: parsed.blocks,
      document: payload.document,
    };
    const expected = typeof payload.expectedEdit === "number" ? payload.expectedEdit : null;
    const repository = access.session.knowledge;
    if (payload.intent === "publish") {
      const result = await publishKnowledge(
        access.membership,
        payload.contentId,
        document,
        expected,
        repository,
      );
      if (result.status === "published") {
        return { status: "published", editCount: null, revisionNo: result.revisionNo };
      }
      return result.status === "invalid"
        ? { status: "invalid", editCount: previous.editCount, issues: result.issues }
        : { status: result.status, editCount: previous.editCount };
    }
    const result = await saveKnowledgeDraft(
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

export interface KnowledgeActionState {
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

export async function retireKnowledgeAction(
  _previous: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const contentId = formData.get("contentId");
    if (typeof contentId !== "string") return { status: "not_found" };
    return await retireKnowledge(access.membership, contentId, access.session.knowledge);
  } catch {
    return { status: "error" };
  }
}

export async function discardKnowledgeAction(
  _previous: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const contentId = formData.get("contentId");
    if (typeof contentId !== "string") return { status: "not_found" };
    return await discardKnowledgeDraft(
      access.membership,
      contentId,
      Number(formData.get("expectedEdit")),
      access.session.knowledge,
    );
  } catch {
    return { status: "error" };
  }
}

// ── Documents ───────────────────────────────────────────────────────────────

export type StartDocumentUploadState =
  RequestDocumentUploadResult | SessionProblem | { status: "error" };

/** Step 1: declares type and size and receives a one-time URL (the file goes to Storage). */
export async function startDocumentUploadAction(
  slug: unknown,
  file: { readonly mime: unknown; readonly bytes: unknown },
): Promise<StartDocumentUploadState> {
  try {
    const access = await context(slug);
    if (!("membership" in access)) return access;
    return await requestDocumentUpload(
      access.membership,
      { mime: file?.mime, bytes: file?.bytes },
      access.session.media,
    );
  } catch {
    return { status: "error" };
  }
}

export type SubmitDocumentState =
  { readonly status: DocumentSubmitOutcome } | { readonly status: "signed_out" | "error" };

/** Step 2: the upload finished; its text is read in the background (a durable job). */
export async function submitDocumentAction(
  slug: unknown,
  versionId: unknown,
): Promise<SubmitDocumentState> {
  try {
    const access = await context(slug);
    if (!("membership" in access)) {
      return { status: access.status === "signed_out" ? "signed_out" : "forbidden" };
    }
    return { status: await submitDocument(access.membership, versionId, access.session.knowledge) };
  } catch {
    return { status: "error" };
  }
}

/** The reading state of a document (the editor asks again while it is being read). */
export async function documentStatusAction(
  slug: unknown,
  reference: { readonly assetId: unknown; readonly version: unknown },
): Promise<DocumentVersionView | null> {
  try {
    const access = await context(slug);
    if (!("membership" in access)) return null;
    const { assetId, version } = reference ?? {};
    if (typeof assetId !== "string" || typeof version !== "number") return null;
    return await access.session.knowledge.findDocument(
      access.membership.tenantId,
      assetId,
      version,
    );
  } catch {
    return null;
  }
}

// ── «Probar la búsqueda» ────────────────────────────────────────────────────

export interface SearchKnowledgeState {
  readonly status: "idle" | "ok" | "invalid" | "forbidden" | "signed_out" | "error";
  readonly query?: string;
  readonly results?: readonly {
    readonly key: string;
    readonly citation: PublicCitation;
    readonly text: string;
  }[];
}

export async function searchKnowledgeAction(
  _previous: SearchKnowledgeState,
  formData: FormData,
): Promise<SearchKnowledgeState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const result = await searchKnowledge(
      access.membership,
      formData.get("query"),
      access.session.knowledge,
    );
    if (result.status === "invalid") return { status: "invalid" };
    return {
      status: "ok",
      query: result.query,
      results: result.passages.map((passage) => ({
        key: passage.chunkId,
        citation: publicCitation(passage),
        text: passage.text,
      })),
    };
  } catch {
    return { status: "error" };
  }
}

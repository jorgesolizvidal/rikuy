"use server";

import {
  createNotice,
  discardNoticeDraft,
  openOrganization,
  parseMarkup,
  publishNotice,
  retireNotice,
  saveNoticeDraft,
  type NoticeIssue,
  type OrganizationMembership,
} from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { refreshPortal } from "@/server/portal-cache";

/*
 * «Avisos» (ADR-069). Every action re-opens the organization with the CURRENT membership,
 * calls one use case and returns state; the browser navigates or refreshes itself (no
 * redirects inside Server Actions, CONTRIBUTING §1.2). Notices have no module: every
 * municipality has them. Whatever visitors see changes (publish, retire), the
 * municipality's portal pages are refreshed: the strip is on all of them.
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

// ── New notice ───────────────────────────────────────────────────────────────

export interface CreateNoticeState {
  readonly status:
    "idle" | "created" | "invalid_title" | "slug_taken" | "forbidden" | "signed_out" | "error";
  readonly contentId?: string;
}

export async function createNoticeAction(
  _previous: CreateNoticeState,
  formData: FormData,
): Promise<CreateNoticeState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const result = await createNotice(
      access.membership,
      { title: formData.get("title"), slug: "" },
      access.session.notices,
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

export interface NoticePayload {
  readonly org: string;
  readonly contentId: string;
  readonly intent: "save" | "publish";
  readonly expectedEdit: number | null;
  readonly title: string;
  readonly summary: string;
  readonly markup: string;
  readonly from: string | null;
  readonly until: string | null;
  readonly placeId: string | null;
}

export interface SaveNoticeState {
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
  readonly issues?: readonly NoticeIssue[];
}

const optional = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

export async function saveNoticeAction(
  previous: Pick<SaveNoticeState, "status" | "editCount">,
  payload: NoticePayload,
): Promise<SaveNoticeState> {
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
      validity: { from: optional(payload.from), until: optional(payload.until) },
      placeId: optional(payload.placeId),
    };
    const expected = typeof payload.expectedEdit === "number" ? payload.expectedEdit : null;
    const repository = access.session.notices;
    if (payload.intent === "publish") {
      const result = await publishNotice(
        access.membership,
        payload.contentId,
        document,
        expected,
        new Date(),
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
    const result = await saveNoticeDraft(
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

export interface NoticeActionState {
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

export async function retireNoticeAction(
  _previous: NoticeActionState,
  formData: FormData,
): Promise<NoticeActionState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const contentId = formData.get("contentId");
    if (typeof contentId !== "string") return { status: "not_found" };
    const result = await retireNotice(access.membership, contentId, access.session.notices);
    if (result.status === "retired") await refresh(access.session, access.membership);
    return result;
  } catch {
    return { status: "error" };
  }
}

export async function discardNoticeAction(
  _previous: NoticeActionState,
  formData: FormData,
): Promise<NoticeActionState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const contentId = formData.get("contentId");
    if (typeof contentId !== "string") return { status: "not_found" };
    return await discardNoticeDraft(
      access.membership,
      contentId,
      Number(formData.get("expectedEdit")),
      access.session.notices,
    );
  } catch {
    return { status: "error" };
  }
}

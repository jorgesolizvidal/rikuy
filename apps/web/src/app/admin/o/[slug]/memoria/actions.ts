"use server";

import {
  createStory,
  discardStoryDraft,
  openOrganization,
  parseMarkup,
  publishStory,
  retireStory,
  saveStoryDraft,
  withModule,
  type OrganizationMembership,
  type StoryIssue,
} from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { refreshPortal } from "@/server/portal-cache";

/*
 * «Memoria de la comunidad» (ADR-069). Every action re-opens the organization with the CURRENT
 * membership and module, calls one use case and returns state; the browser navigates or
 * refreshes itself (no redirects inside Server Actions, CONTRIBUTING §1.2). Whatever visitors
 * see changes (publish, retire), the municipality's portal pages are refreshed: the stories are
 * on `/memoria`, on their destination's page and in the header.
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
  const membership = withModule(
    typeof slug === "string" ? await openOrganization(actor, slug, session.memberships) : null,
    "community_memory",
  );
  return membership === null ? { status: "forbidden" } : { membership, session };
}

async function refresh(
  session: Awaited<ReturnType<typeof adminSession>>,
  membership: OrganizationMembership,
): Promise<void> {
  await refreshPortal((tenantId) => session.content.portalHostname(tenantId), membership.tenantId);
}

// ── New story ────────────────────────────────────────────────────────────────

export interface CreateStoryState {
  readonly status:
    "idle" | "created" | "invalid_title" | "slug_taken" | "forbidden" | "signed_out" | "error";
  readonly contentId?: string;
}

export async function createStoryAction(
  _previous: CreateStoryState,
  formData: FormData,
): Promise<CreateStoryState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const result = await createStory(
      access.membership,
      { title: formData.get("title"), slug: "" },
      access.session.stories,
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

export interface StoryPayload {
  readonly org: string;
  readonly contentId: string;
  readonly intent: "save" | "publish";
  readonly expectedEdit: number | null;
  readonly title: string;
  readonly summary: string;
  /** The text as written in the editor (the limited Markdown of destinations). */
  readonly markup: string;
  readonly author: string;
  readonly anonymous: boolean;
  readonly community: string;
  readonly placeId: string | null;
  readonly consent: boolean;
}

export interface SaveStoryState {
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
  readonly issues?: readonly StoryIssue[];
}

export async function saveStoryAction(
  previous: Pick<SaveStoryState, "status" | "editCount">,
  payload: StoryPayload,
): Promise<SaveStoryState> {
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
      author: payload.author,
      anonymous: payload.anonymous,
      community: payload.community,
      placeId: payload.placeId,
      consent: payload.consent,
    };
    const expected = typeof payload.expectedEdit === "number" ? payload.expectedEdit : null;
    const repository = access.session.stories;
    if (payload.intent === "publish") {
      const result = await publishStory(
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
    const result = await saveStoryDraft(
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

export interface StoryActionState {
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

export async function retireStoryAction(
  _previous: StoryActionState,
  formData: FormData,
): Promise<StoryActionState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const contentId = formData.get("contentId");
    if (typeof contentId !== "string") return { status: "not_found" };
    const result = await retireStory(access.membership, contentId, access.session.stories);
    if (result.status === "retired") await refresh(access.session, access.membership);
    return result;
  } catch {
    return { status: "error" };
  }
}

export async function discardStoryAction(
  _previous: StoryActionState,
  formData: FormData,
): Promise<StoryActionState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const contentId = formData.get("contentId");
    if (typeof contentId !== "string") return { status: "not_found" };
    return await discardStoryDraft(
      access.membership,
      contentId,
      Number(formData.get("expectedEdit")),
      access.session.stories,
    );
  } catch {
    return { status: "error" };
  }
}

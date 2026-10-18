"use server";

import {
  confirmContentImageUpload,
  createDestination,
  createEvent,
  discardDestinationDraft,
  openOrganization,
  parseMarkup,
  publishDestination,
  publishEvent,
  requestContentImageUpload,
  restoreDestinationRevision,
  saveDestinationDraft,
  saveEventDraft,
  type ConfirmImageUploadResult,
  type DestinationIssue,
  type OrganizationMembership,
  type RequestImageUploadResult,
} from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { imageProcessor, mediaAdmin } from "@/server/media-admin";

/*
 * Editorial content Server Actions (destinations and events). Every action re-opens the organization with the CURRENT
 * membership, calls one use case and returns state; the browser navigates or refreshes
 * itself (no redirects inside Server Actions, see CONTRIBUTING §1.2).
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

export type ContentKindName = "destination" | "event";

// ── New destination or event ─────────────────────────────────────────────────

export interface CreateDestinationState {
  readonly status:
    | "idle"
    | "created"
    | "invalid_title"
    | "invalid_slug"
    | "slug_taken"
    | "forbidden"
    | "signed_out"
    | "error";
  readonly contentId?: string;
}

export async function createDestinationAction(
  _previous: CreateDestinationState,
  formData: FormData,
): Promise<CreateDestinationState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const input = { title: formData.get("title"), slug: formData.get("slug") };
    const result =
      formData.get("kind") === "event"
        ? await createEvent(access.membership, input, access.session.content)
        : await createDestination(access.membership, input, access.session.content);
    switch (result.status) {
      case "created":
        return { status: "created", contentId: result.contentId };
      case "invalid":
        return { status: result.field === "title" ? "invalid_title" : "invalid_slug" };
      default:
        return { status: result.status };
    }
  } catch {
    return { status: "error" };
  }
}

// ── Editor: save draft / publish ─────────────────────────────────────────────

export interface DestinationPayload {
  readonly kind: ContentKindName;
  readonly org: string;
  readonly contentId: string;
  readonly intent: "save" | "publish";
  readonly expectedEdit: number | null;
  readonly title: string;
  readonly summary: string;
  /** The text as written in the editor (parsed to the rich text AST here). */
  readonly markup: string;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly cover: {
    readonly assetId: string;
    readonly version: number;
    readonly alt: string;
  } | null;
  readonly gallery: readonly {
    readonly assetId: string;
    readonly version: number;
    readonly alt: string;
  }[];
  /** Events only. */
  readonly schedule?: {
    readonly allDay: boolean;
    readonly start: string;
    readonly end: string;
  } | null;
  readonly venueId?: string | null;
}

export interface SaveDestinationState {
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
  /** Lines of the text with links that are not https. */
  readonly linkLines?: readonly number[];
}

export async function saveDestinationAction(
  previous: SaveDestinationState,
  payload: DestinationPayload,
): Promise<SaveDestinationState> {
  const keep = { editCount: previous.editCount ?? payload.expectedEdit };
  try {
    const access = await context(payload.org);
    if (!("membership" in access)) return { ...access, ...keep };

    const parsed = parseMarkup(typeof payload.markup === "string" ? payload.markup : "");
    if (parsed.problems.length > 0) {
      return {
        status: "invalid",
        ...keep,
        issues: [{ path: "body", code: "invalid" }],
        linkLines: parsed.problems.map((problem) => problem.line),
      };
    }
    const base = {
      title: payload.title,
      summary: payload.summary,
      body: parsed.blocks,
      location: payload.location,
      cover: payload.cover,
      gallery: payload.gallery,
    };
    const { membership, session } = access;
    const publish = payload.intent === "publish";

    const result =
      payload.kind === "event"
        ? publish
          ? await publishEvent(
              membership,
              payload.contentId,
              { ...base, schedule: payload.schedule ?? null, venueId: payload.venueId ?? null },
              payload.expectedEdit,
              session.content,
              mediaAdmin(),
            )
          : await saveEventDraft(
              membership,
              payload.contentId,
              { ...base, schedule: payload.schedule ?? null, venueId: payload.venueId ?? null },
              payload.expectedEdit,
              session.content,
            )
        : publish
          ? await publishDestination(
              membership,
              payload.contentId,
              base,
              payload.expectedEdit,
              session.content,
              mediaAdmin(),
            )
          : await saveDestinationDraft(
              membership,
              payload.contentId,
              base,
              payload.expectedEdit,
              session.content,
            );

    switch (result.status) {
      case "saved":
        return { status: "saved", editCount: result.editCount, revisionNo: result.revisionNo };
      case "published":
        return { status: "published", editCount: null, revisionNo: result.revisionNo };
      case "invalid":
        return { status: "invalid", ...keep, issues: result.issues };
      default:
        return { status: result.status, ...keep };
    }
  } catch {
    return { status: "error", ...keep };
  }
}

// ── History: roll back / discard ─────────────────────────────────────────────

export interface RevisionActionState {
  readonly status:
    | "idle"
    | "restored"
    | "discarded"
    | "never_published"
    | "conflict"
    | "forbidden"
    | "not_found"
    | "signed_out"
    | "error";
}

export async function restoreRevisionAction(
  _previous: RevisionActionState,
  formData: FormData,
): Promise<RevisionActionState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const contentId = formData.get("contentId");
    if (typeof contentId !== "string") return { status: "not_found" };
    const result = await restoreDestinationRevision(
      access.membership,
      contentId,
      formData.get("revisionId"),
      access.session.content,
    );
    return { status: result.status };
  } catch {
    return { status: "error" };
  }
}

export async function discardDraftAction(
  _previous: RevisionActionState,
  formData: FormData,
): Promise<RevisionActionState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const contentId = formData.get("contentId");
    if (typeof contentId !== "string") return { status: "not_found" };
    const expected = Number(formData.get("expectedEdit"));
    const result = await discardDestinationDraft(
      access.membership,
      contentId,
      Number.isInteger(expected) ? expected : null,
      access.session.content,
    );
    return { status: result.status };
  } catch {
    return { status: "error" };
  }
}

// ── Photos (bytes go straight to Storage; the server only checks them) ──────

export type StartImageUploadState = RequestImageUploadResult | SessionProblem | { status: "error" };

export async function startContentImageUploadAction(
  org: unknown,
  file: { readonly mime: unknown; readonly bytes: unknown },
): Promise<StartImageUploadState> {
  try {
    const access = await context(org);
    if (!("membership" in access)) return access;
    return await requestContentImageUpload(
      access.membership,
      { mime: file?.mime, bytes: file?.bytes },
      access.session.media,
    );
  } catch {
    return { status: "error" };
  }
}

export type ConfirmImageUploadState =
  ConfirmImageUploadResult | SessionProblem | { status: "error" };

export async function confirmContentImageUploadAction(
  org: unknown,
  versionId: unknown,
): Promise<ConfirmImageUploadState> {
  try {
    const access = await context(org);
    if (!("membership" in access)) return access;
    return await confirmContentImageUpload(access.membership, versionId, {
      media: access.session.media,
      admin: mediaAdmin(),
      processor: imageProcessor(),
    });
  } catch {
    return { status: "error" };
  }
}

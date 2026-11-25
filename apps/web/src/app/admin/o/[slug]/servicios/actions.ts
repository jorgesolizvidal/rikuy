"use server";

import {
  createService,
  discardServiceDraft,
  openOrganization,
  publishService,
  retireService,
  saveServiceDraft,
  withModule,
  type OpeningHours,
  type OrganizationMembership,
  type ServiceIssue,
} from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { refreshPortal } from "@/server/portal-cache";

/*
 * «Servicios locales» (ADR-069). Every action re-opens the organization with the CURRENT
 * membership and module, calls one use case and returns state; the browser navigates or
 * refreshes itself (no redirects inside Server Actions, CONTRIBUTING §1.2). Whatever visitors
 * see changes (publish, retire), the municipality's portal pages are refreshed: the services
 * are on `/servicios`, in the header and on the map.
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
    "services",
  );
  return membership === null ? { status: "forbidden" } : { membership, session };
}

async function refresh(
  session: Awaited<ReturnType<typeof adminSession>>,
  membership: OrganizationMembership,
): Promise<void> {
  await refreshPortal((tenantId) => session.content.portalHostname(tenantId), membership.tenantId);
}

// ── New service ──────────────────────────────────────────────────────────────

export interface CreateServiceState {
  readonly status:
    "idle" | "created" | "invalid_title" | "slug_taken" | "forbidden" | "signed_out" | "error";
  readonly contentId?: string;
}

export async function createServiceAction(
  _previous: CreateServiceState,
  formData: FormData,
): Promise<CreateServiceState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const result = await createService(
      access.membership,
      { title: formData.get("title"), slug: "" },
      access.session.services,
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

export interface ServicePayload {
  readonly org: string;
  readonly contentId: string;
  readonly intent: "save" | "publish";
  readonly expectedEdit: number | null;
  readonly title: string;
  readonly summary: string;
  readonly category: string;
  readonly hours: OpeningHours | null;
  readonly phone: string;
  readonly whatsapp: string;
  readonly address: string;
  readonly location: { readonly lat: number; readonly lng: number } | null;
}

export interface SaveServiceState {
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
  readonly issues?: readonly ServiceIssue[];
}

export async function saveServiceAction(
  previous: Pick<SaveServiceState, "status" | "editCount">,
  payload: ServicePayload,
): Promise<SaveServiceState> {
  try {
    const access = await context(payload?.org);
    if (!("membership" in access)) return { ...access, editCount: previous.editCount };
    // The use case validates every field: the payload goes as it came.
    const document = {
      title: payload.title,
      summary: payload.summary,
      category: payload.category,
      hours: payload.hours,
      phone: payload.phone,
      whatsapp: payload.whatsapp,
      address: payload.address,
      location: payload.location,
    };
    const expected = typeof payload.expectedEdit === "number" ? payload.expectedEdit : null;
    const repository = access.session.services;
    if (payload.intent === "publish") {
      const result = await publishService(
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
    const result = await saveServiceDraft(
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

export interface ServiceActionState {
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

export async function retireServiceAction(
  _previous: ServiceActionState,
  formData: FormData,
): Promise<ServiceActionState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const contentId = formData.get("contentId");
    if (typeof contentId !== "string") return { status: "not_found" };
    const result = await retireService(access.membership, contentId, access.session.services);
    if (result.status === "retired") await refresh(access.session, access.membership);
    return result;
  } catch {
    return { status: "error" };
  }
}

export async function discardServiceAction(
  _previous: ServiceActionState,
  formData: FormData,
): Promise<ServiceActionState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const contentId = formData.get("contentId");
    if (typeof contentId !== "string") return { status: "not_found" };
    return await discardServiceDraft(
      access.membership,
      contentId,
      Number(formData.get("expectedEdit")),
      access.session.services,
    );
  } catch {
    return { status: "error" };
  }
}

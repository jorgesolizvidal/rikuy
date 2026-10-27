"use server";

import {
  buildSampleTour,
  loadSampleContent,
  openOrganization,
  type OrganizationMembership,
  type SampleContentResult,
  type SampleTourResult,
} from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { imageProcessor, mediaAdmin, sampleImageRenderer } from "@/server/media-admin";
import { refreshPortal } from "@/server/portal-cache";

/*
 * Sample content of a commercial demo (ADR-034). Each action re-opens the organization with
 * the CURRENT membership and calls one use case, which checks that it is a demo and that
 * the person is an owner or an administrator. No redirects (CONTRIBUTING §1.2).
 */

type SessionProblem = { readonly status: "signed_out" | "forbidden" };

async function context(slug: unknown): Promise<
  | {
      membership: OrganizationMembership;
      session: Awaited<ReturnType<typeof adminSession>>;
    }
  | SessionProblem
> {
  const actor = await currentAdminActor();
  if (actor === null) return { status: "signed_out" };
  const session = await adminSession();
  const membership =
    typeof slug === "string" ? await openOrganization(actor, slug, session.memberships) : null;
  return membership === null ? { status: "forbidden" } : { membership, session };
}

/** The server puts the illustration at the one-time URL, as the browser would. */
async function upload(url: string, bytes: Uint8Array, mime: string): Promise<boolean> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": mime },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  return response.ok;
}

function deps(session: Awaited<ReturnType<typeof adminSession>>) {
  return {
    content: session.content,
    media: session.media,
    admin: mediaAdmin(),
    processor: imageProcessor(),
    panoramas: session.panoramas,
    tours: session.tours,
    renderer: sampleImageRenderer(),
    upload,
    now: () => new Date(),
  };
}

export type LoadSampleState = SampleContentResult | SessionProblem | { readonly status: "error" };

export async function loadSampleContentAction(
  slug: unknown,
  center: unknown,
): Promise<LoadSampleState> {
  try {
    const access = await context(slug);
    if (!("membership" in access)) return access;
    const { membership, session } = access;
    const result = await loadSampleContent(membership, { center }, deps(session));
    if (result.status === "loaded" || result.status === "failed") {
      await refreshPortal((id) => session.content.portalHostname(id), membership.tenantId);
    }
    return result;
  } catch {
    return { status: "error" };
  }
}

export type SampleTourState = SampleTourResult | SessionProblem | { readonly status: "error" };

export async function buildSampleTourAction(slug: unknown): Promise<SampleTourState> {
  try {
    const access = await context(slug);
    if (!("membership" in access)) return access;
    const { membership, session } = access;
    const result = await buildSampleTour(membership, deps(session));
    if (result.status === "built") {
      await refreshPortal((id) => session.content.portalHostname(id), membership.tenantId);
    }
    return result;
  } catch {
    return { status: "error" };
  }
}

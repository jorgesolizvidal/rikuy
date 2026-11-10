"use server";

import {
  deleteTourMedia,
  openOrganization,
  applyMediaReplacement,
  type ApplyReplacementOutcome,
  type DeleteMediaOutcome,
  type OrganizationMembership,
} from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";

/*
 * Replacing and deleting panoramas and 3D models (ADR-048). Each action re-opens the
 * organization with the current membership and returns state; the page refreshes itself.
 * Nothing here reaches visitors: a replacement goes to the tours' drafts, and only what no
 * tour ever used can be deleted.
 */

type SessionProblem = { readonly status: "signed_out" | "forbidden" };

async function membershipFor(
  slug: unknown,
): Promise<{ membership: OrganizationMembership } | SessionProblem> {
  const actor = await currentAdminActor();
  if (actor === null) return { status: "signed_out" };
  const membership =
    typeof slug === "string"
      ? await openOrganization(actor, slug, (await adminSession()).memberships)
      : null;
  return membership === null ? { status: "forbidden" } : { membership };
}

export type ApplyReplacementState = ApplyReplacementOutcome | SessionProblem | { status: "error" };

/** «Usar la versión nueva en los tours»: it goes to the draft of each tour that uses it. */
export async function applyReplacementAction(
  slug: unknown,
  versionId: unknown,
): Promise<ApplyReplacementState> {
  try {
    const access = await membershipFor(slug);
    if (!("membership" in access)) return access;
    return await applyMediaReplacement(
      access.membership,
      versionId,
      (await adminSession()).library,
    );
  } catch {
    return { status: "error" };
  }
}

export type DeleteMediaState = DeleteMediaOutcome | SessionProblem | { status: "error" };

/** «Borrar»: only a panorama or model no tour ever used; its files go with it. */
export async function deleteMediaAction(
  slug: unknown,
  assetId: unknown,
): Promise<DeleteMediaState> {
  try {
    const access = await membershipFor(slug);
    if (!("membership" in access)) return access;
    return await deleteTourMedia(access.membership, assetId, (await adminSession()).library);
  } catch {
    return { status: "error" };
  }
}

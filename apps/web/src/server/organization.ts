import "server-only";

import { organizationAccess, type OrganizationMembership } from "@rikuy/core";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { adminSession, requireAdminActor } from "./admin-session";

/**
 * The signed-in user's CURRENT membership in the organization `slug` (read live on every
 * request). No session → login; no membership → 404, so the existence of other
 * organizations is never revealed; an owner or admin without the second factor in this
 * session → /verificacion, and back here once verified (ADR-043). For pages only: Server
 * Actions must not redirect.
 */
export const requireOrganization = cache(async (slug: string): Promise<OrganizationMembership> => {
  const actor = await requireAdminActor();
  const access = await organizationAccess(actor, slug, (await adminSession()).memberships);
  if (access.status === "not_found") notFound();
  if (access.status === "second_factor") {
    redirect(`/verificacion?siguiente=${encodeURIComponent(`/o/${access.membership.slug}`)}`);
  }
  return access.membership;
});

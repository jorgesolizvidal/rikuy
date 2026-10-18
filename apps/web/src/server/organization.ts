import "server-only";

import { openOrganization, type OrganizationMembership } from "@rikuy/core";
import { notFound } from "next/navigation";
import { cache } from "react";

import { adminSession, requireAdminActor } from "./admin-session";

/**
 * The signed-in user's CURRENT membership in the organization `slug` (read live on every
 * request). No session → login; no membership → 404, so the existence of other
 * organizations is never revealed. For pages only: Server Actions must not redirect.
 */
export const requireOrganization = cache(async (slug: string): Promise<OrganizationMembership> => {
  const actor = await requireAdminActor();
  const membership = await openOrganization(actor, slug, (await adminSession()).memberships);
  if (membership === null) notFound();
  return membership;
});

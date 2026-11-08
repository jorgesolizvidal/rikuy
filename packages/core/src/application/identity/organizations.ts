import type { Actor, OrganizationMembership } from "../../contracts/organization";
import type { MembershipReader } from "./ports";

/** Organizations the actor can currently open, sorted by name. */
export async function listMyOrganizations(
  actor: Actor,
  reader: MembershipReader,
): Promise<OrganizationMembership[]> {
  const memberships = await reader.listActiveMemberships(actor.userId);
  return [...memberships].sort((a, b) => a.displayName.localeCompare(b.displayName, "es"));
}

export type OrganizationAccess =
  | { readonly status: "open"; readonly membership: OrganizationMembership }
  /** Owner or admin without a verified second factor in this session (ADR-043). */
  | { readonly status: "second_factor"; readonly membership: OrganizationMembership }
  | { readonly status: "not_found" };

/**
 * Where the actor stands in the organization `slug`. Membership is read live on every
 * call: a revoked member loses access immediately. `not_found` never reveals whether the
 * organization exists.
 */
export async function organizationAccess(
  actor: Actor,
  slug: string,
  reader: MembershipReader,
): Promise<OrganizationAccess> {
  const memberships = await reader.listActiveMemberships(actor.userId);
  const membership = memberships.find((entry) => entry.slug === slug);
  if (!membership) return { status: "not_found" };
  return membership.needsSecondFactor
    ? { status: "second_factor", membership }
    : { status: "open", membership };
}

/**
 * The actor's membership in the organization identified by `slug`, or null when they
 * cannot act in it right now (no membership, or an owner/admin still missing the second
 * factor). Callers must treat null as "not found"; the database refuses the same cases.
 */
export async function openOrganization(
  actor: Actor,
  slug: string,
  reader: MembershipReader,
): Promise<OrganizationMembership | null> {
  const access = await organizationAccess(actor, slug, reader);
  return access.status === "open" ? access.membership : null;
}

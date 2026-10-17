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

/**
 * The actor's membership in the organization identified by `slug`, or null. Callers must
 * treat null as "not found" so the existence of other organizations is never revealed.
 * Membership is read live on every call: a revoked member loses access immediately.
 */
export async function openOrganization(
  actor: Actor,
  slug: string,
  reader: MembershipReader,
): Promise<OrganizationMembership | null> {
  const memberships = await reader.listActiveMemberships(actor.userId);
  return memberships.find((membership) => membership.slug === slug) ?? null;
}

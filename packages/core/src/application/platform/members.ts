import {
  membershipRoleSchema,
  type MembershipRole,
  type OrganizationMembership,
} from "../../contracts/organization";
import { normalizeEmail } from "../../domain/identity/email";
import type {
  IdentityAdmin,
  InvitationRepository,
  MemberChangeOutcome,
  MemberRepository,
  PendingInvitation,
  TenantMember,
} from "./ports";

/** Owners and administrators see and manage the roster. */
export function canManageMembers(role: MembershipRole): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Role rules (also enforced by the database): owners manage every role; administrators
 * only editors and analysts, never owners or other administrators.
 */
export function canAssignRole(
  actor: MembershipRole,
  target: MembershipRole | null,
  next: MembershipRole | null,
): boolean {
  if (actor === "owner") return true;
  if (actor !== "admin") return false;
  const limited = (role: MembershipRole | null) =>
    role === null || role === "editor" || role === "analyst";
  return limited(target) && limited(next);
}

/** Roles the actor may hand out, in display order. */
export function assignableRoles(actor: MembershipRole): MembershipRole[] {
  return membershipRoleSchema.options.filter((role) => canAssignRole(actor, null, role));
}

export async function listMembers(
  membership: OrganizationMembership,
  members: MemberRepository,
): Promise<TenantMember[] | null> {
  if (!canManageMembers(membership.role)) return null;
  return members.list(membership.tenantId);
}

export type InviteMemberResult =
  MemberChangeOutcome | { readonly status: "invalid_email" } | { readonly status: "invalid_role" };

export async function inviteMember(
  membership: OrganizationMembership,
  input: { readonly email: unknown; readonly role: unknown },
  deps: { readonly members: MemberRepository; readonly identity: IdentityAdmin },
): Promise<InviteMemberResult> {
  const role = membershipRoleSchema.safeParse(input.role);
  if (!role.success) return { status: "invalid_role" };
  // Authorize BEFORE touching identity administration.
  if (!canAssignRole(membership.role, null, role.data)) return { status: "forbidden" };
  const email = normalizeEmail(input.email);
  if (email === null) return { status: "invalid_email" };

  const user = await deps.identity.ensureUser(email);
  return deps.members.add(membership.tenantId, user.userId, role.data);
}

export async function changeMemberRole(
  membership: OrganizationMembership,
  input: { readonly membershipId: unknown; readonly role: unknown; readonly currentRole: unknown },
  members: MemberRepository,
): Promise<MemberChangeOutcome | { readonly status: "invalid_role" }> {
  const role = membershipRoleSchema.safeParse(input.role);
  const current = membershipRoleSchema.safeParse(input.currentRole);
  if (!role.success || !current.success || typeof input.membershipId !== "string") {
    return { status: "invalid_role" };
  }
  if (!canAssignRole(membership.role, current.data, role.data)) return { status: "forbidden" };
  return members.changeRole(membership.tenantId, input.membershipId, role.data);
}

export async function revokeMember(
  membership: OrganizationMembership,
  input: { readonly membershipId: unknown; readonly currentRole: unknown },
  members: MemberRepository,
): Promise<MemberChangeOutcome | { readonly status: "invalid_role" }> {
  const current = membershipRoleSchema.safeParse(input.currentRole);
  if (!current.success || typeof input.membershipId !== "string") {
    return { status: "invalid_role" };
  }
  if (!canAssignRole(membership.role, current.data, null)) return { status: "forbidden" };
  return members.revoke(membership.tenantId, input.membershipId);
}

export function listMyInvitations(invitations: InvitationRepository): Promise<PendingInvitation[]> {
  return invitations.listPending();
}

export async function acceptInvitation(
  invitations: InvitationRepository,
  tenantId: unknown,
): Promise<"accepted" | "not_found"> {
  if (typeof tenantId !== "string" || tenantId === "") return "not_found";
  return invitations.accept(tenantId);
}

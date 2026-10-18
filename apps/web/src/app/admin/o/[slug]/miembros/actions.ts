"use server";

import { changeMemberRole, inviteMember, openOrganization, revokeMember } from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { identityAdmin } from "@/server/identity-admin";

export interface MemberActionState {
  readonly status:
    | "idle"
    | "done"
    | "forbidden"
    | "not_found"
    | "last_owner"
    | "already_member"
    | "invalid_email"
    | "invalid_role"
    | "error";
}

async function membershipFor(slug: FormDataEntryValue | null) {
  const actor = await currentAdminActor();
  if (actor === null || typeof slug !== "string") return null;
  const session = await adminSession();
  const membership = await openOrganization(actor, slug, session.memberships);
  return membership ? { membership, session } : null;
}

/** Invites by email. The role rules run before any account is created. */
export async function inviteMemberAction(
  _previous: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  try {
    const context = await membershipFor(formData.get("slug"));
    if (context === null) return { status: "forbidden" };
    const result = await inviteMember(
      context.membership,
      { email: formData.get("email"), role: formData.get("role") },
      {
        members: context.session.members,
        identity: { ensureUser: (email) => identityAdmin().ensureUser(email) },
      },
    );
    return { status: result.status };
  } catch {
    return { status: "error" };
  }
}

export async function changeRoleAction(
  _previous: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  try {
    const context = await membershipFor(formData.get("slug"));
    if (context === null) return { status: "forbidden" };
    const result = await changeMemberRole(
      context.membership,
      {
        membershipId: formData.get("membershipId"),
        role: formData.get("role"),
        currentRole: formData.get("currentRole"),
      },
      context.session.members,
    );
    return { status: result.status };
  } catch {
    return { status: "error" };
  }
}

export async function revokeMemberAction(
  _previous: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  try {
    const context = await membershipFor(formData.get("slug"));
    if (context === null) return { status: "forbidden" };
    const result = await revokeMember(
      context.membership,
      { membershipId: formData.get("membershipId"), currentRole: formData.get("currentRole") },
      context.session.members,
    );
    return { status: result.status };
  } catch {
    return { status: "error" };
  }
}

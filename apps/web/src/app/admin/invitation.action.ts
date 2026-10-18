"use server";

import { acceptInvitation } from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";

export interface AcceptState {
  readonly status: "idle" | "accepted" | "not_found" | "error";
}

/** Accepts an invitation addressed to the signed-in user (checked in the database). */
export async function acceptInvitationAction(
  _previous: AcceptState,
  formData: FormData,
): Promise<AcceptState> {
  try {
    if ((await currentAdminActor()) === null) return { status: "not_found" };
    const { invitations } = await adminSession();
    return { status: await acceptInvitation(invitations, formData.get("tenantId")) };
  } catch {
    return { status: "error" };
  }
}

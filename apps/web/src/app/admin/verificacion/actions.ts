"use server";

import { startStaffEnrollment, verifyStaffCode } from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";

import type { EnrollState, VerifyState } from "../mfa-panel";

// Second factor of the owners and admins of a municipality (ADR-043). Each action reads the
// person's memberships again: only someone who needs it can enroll or verify. The database
// enforces aal2 on its own. None of them redirects: the client navigates on success.

export async function startStaffEnrollmentAction(): Promise<EnrollState> {
  try {
    const actor = await currentAdminActor();
    if (actor === null) return { status: "denied" };
    const { memberships, mfa } = await adminSession();
    const enrollment = await startStaffEnrollment(actor, memberships, mfa);
    return enrollment ? { status: "enrolling", ...enrollment } : { status: "denied" };
  } catch {
    return { status: "error" };
  }
}

export async function verifyStaffAction(
  _previous: VerifyState,
  formData: FormData,
): Promise<VerifyState> {
  try {
    const actor = await currentAdminActor();
    if (actor === null) return { status: "denied" };
    const { memberships, mfa } = await adminSession();
    const status = await verifyStaffCode(
      actor,
      memberships,
      mfa,
      formData.get("factorId"),
      formData.get("code"),
    );
    // Nothing left to verify (another tab already did it): continue as verified.
    return { status: status === "not_needed" ? "verified" : status };
  } catch {
    return { status: "unavailable" };
  }
}

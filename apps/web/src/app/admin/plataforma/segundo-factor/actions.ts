"use server";

import { resetSecondFactor } from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";

// The operator (with their own second factor) removes the TOTP factors of an owner or admin
// who lost their phone (ADR-043). The database re-checks the operator, removes the factors
// and audits it in one transaction. No redirects: the form shows the outcome.

export interface ResetState {
  readonly status:
    "idle" | "reset" | "not_found" | "self" | "forbidden" | "invalid_email" | "error";
  readonly email?: string;
  readonly removed?: number;
}

export async function resetSecondFactorAction(
  _previous: ResetState,
  formData: FormData,
): Promise<ResetState> {
  try {
    if ((await currentAdminActor()) === null) return { status: "forbidden" };
    const { platform } = await adminSession();
    const email = formData.get("email");
    const outcome = await resetSecondFactor(platform, email);
    return outcome.status === "reset"
      ? { status: "reset", email: String(email).trim(), removed: outcome.removed }
      : { status: outcome.status };
  } catch {
    return { status: "error" };
  }
}

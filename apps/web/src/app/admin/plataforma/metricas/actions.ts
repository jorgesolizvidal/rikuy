"use server";

import { checkPublicationNow } from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";

// The database re-checks the operator and its second factor. No redirects: the client
// refreshes the page on success.

export interface CheckState {
  readonly status: "idle" | "checked" | "not_found" | "forbidden" | "error";
}

export async function checkPublicationAction(
  _previous: CheckState,
  formData: FormData,
): Promise<CheckState> {
  try {
    if ((await currentAdminActor()) === null) return { status: "forbidden" };
    const { platform, metrics } = await adminSession();
    return { status: await checkPublicationNow(platform, metrics, formData.get("tenantId")) };
  } catch {
    return { status: "error" };
  }
}

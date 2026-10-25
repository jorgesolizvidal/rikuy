"use server";

import { changeQuota, type SetQuotaOutcome } from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";

// The database re-checks the operator and its second factor. No redirects: the client
// refreshes on success.

export interface QuotaState {
  readonly status: "idle" | SetQuotaOutcome | "error";
}

export async function changeQuotaAction(
  _previous: QuotaState,
  formData: FormData,
): Promise<QuotaState> {
  try {
    if ((await currentAdminActor()) === null) return { status: "forbidden" };
    const { platformUsage } = await adminSession();
    return {
      status: await changeQuota(
        {
          tenantId: formData.get("tenantId"),
          resource: formData.get("resource"),
          value: formData.get("value"),
        },
        platformUsage,
      ),
    };
  } catch {
    return { status: "error" };
  }
}

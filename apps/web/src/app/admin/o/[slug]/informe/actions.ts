"use server";

import { isReportMonth, openOrganization, requestMonthlyReport } from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";

/*
 * «Enviar este informe ahora por correo» (ADR-055). Re-opens the organization with the
 * CURRENT membership, calls one use case and returns state; the browser refreshes the page by
 * itself (no redirects inside Server Actions, CONTRIBUTING §1.2).
 */

export interface SendReportState {
  readonly status:
    | "idle"
    | "queued"
    | "too_many"
    | "not_online"
    | "invalid"
    | "forbidden"
    | "signed_out"
    | "error";
  /** Changes on every answer, so the page refreshes once per answer. */
  readonly at?: number;
}

export async function sendMonthlyReportAction(
  _previous: SendReportState,
  formData: FormData,
): Promise<SendReportState> {
  try {
    const actor = await currentAdminActor();
    if (actor === null) return { status: "signed_out" };
    const slug = formData.get("org");
    const month = formData.get("month");
    if (!isReportMonth(month)) return { status: "invalid" };
    const session = await adminSession();
    const membership =
      typeof slug === "string" ? await openOrganization(actor, slug, session.memberships) : null;
    if (membership === null) return { status: "forbidden" };
    const outcome = await requestMonthlyReport(membership, session.reports, month);
    return { status: outcome, at: Date.now() };
  } catch {
    return { status: "error" };
  }
}

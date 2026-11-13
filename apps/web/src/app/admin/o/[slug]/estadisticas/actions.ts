"use server";

import { generateRecommendations, openOrganization } from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { recommendationsDeps } from "@/server/copilot";

/*
 * «Generar recomendaciones» (ADR-054). Re-opens the organization with the CURRENT membership,
 * calls one use case and returns state; the browser refreshes the page by itself (no
 * redirects inside Server Actions, CONTRIBUTING §1.2).
 */

export interface RecommendState {
  readonly status: "idle" | "saved" | "notice" | "forbidden" | "signed_out" | "error";
  readonly message?: string;
  readonly count?: number;
  /** Changes on every answer, so the page refreshes once per answer. */
  readonly at?: number;
}

export async function generateRecommendationsAction(
  _previous: RecommendState,
  formData: FormData,
): Promise<RecommendState> {
  try {
    const actor = await currentAdminActor();
    if (actor === null) return { status: "signed_out" };
    const slug = formData.get("org");
    const session = await adminSession();
    const membership =
      typeof slug === "string" ? await openOrganization(actor, slug, session.memberships) : null;
    if (membership === null) return { status: "forbidden" };
    const outcome = await generateRecommendations(
      membership,
      actor.userId,
      await recommendationsDeps(),
    );
    if (outcome.status === "saved") {
      return { status: "saved", count: outcome.count, at: Date.now() };
    }
    if (outcome.status === "notice") {
      return { status: "notice", message: outcome.message, at: Date.now() };
    }
    return { status: "forbidden" };
  } catch {
    return { status: "error" };
  }
}

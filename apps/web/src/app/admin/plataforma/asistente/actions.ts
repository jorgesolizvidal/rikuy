"use server";

import { evaluateAssistantGold, type GoldRunCase } from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { askPortalAssistant } from "@/server/portal-assistant";
import { portalView } from "@/server/portal-view";

export type GoldRunState =
  | { readonly status: "idle" }
  | {
      readonly status: "done";
      readonly cases: readonly GoldRunCase[];
      readonly next: number | null;
    }
  | { readonly status: "forbidden" | "not_found" | "not_ready" | "invalid" | "error" };

/**
 * «Evaluar el asistente» (D7, ADR-038): five gold cases against a demo's portal, with the
 * real model, spaced so they stay under the provider's tokens per minute.
 */
export async function evaluateGoldAction(tenantId: unknown, from: unknown): Promise<GoldRunState> {
  try {
    if ((await currentAdminActor()) === null) return { status: "forbidden" };
    const { platform } = await adminSession();
    return await evaluateAssistantGold(
      { tenantId, from },
      {
        platform,
        ask: async (host, body) => {
          const view = await portalView(host);
          if (view === null) throw new Error("portal not found");
          return askPortalAssistant(view, body, null);
        },
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
    );
  } catch {
    return { status: "error" };
  }
}

"use server";

import { openOrganization, saveCategories, type CategoryKind } from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { refreshPortal } from "@/server/portal-cache";

/*
 * Categories of the municipality (ADR-062). The action re-opens the organization with the
 * CURRENT membership, calls the use case and returns state (no redirects, CONTRIBUTING §1.2).
 * Renaming or removing a category changes the portal's filters: its pages are refreshed.
 */

export interface SaveCategoriesState {
  readonly status:
    "idle" | "saved" | "duplicate" | "invalid" | "forbidden" | "signed_out" | "error";
  readonly name?: string;
  readonly index?: number;
}

export async function saveCategoriesAction(input: {
  readonly org: string;
  readonly kind: CategoryKind;
  readonly categories: readonly { readonly id?: string; readonly name: string }[];
}): Promise<SaveCategoriesState> {
  try {
    const actor = await currentAdminActor();
    if (actor === null) return { status: "signed_out" };
    const session = await adminSession();
    const membership = await openOrganization(actor, input.org, session.memberships);
    if (membership === null) return { status: "forbidden" };
    if (input.kind !== "destination" && input.kind !== "event") return { status: "invalid" };
    const result = await saveCategories(membership, input.kind, input.categories, {
      categories: session.categories,
    });
    if (result.status === "saved") {
      await refreshPortal(
        (tenantId) => session.content.portalHostname(tenantId),
        membership.tenantId,
      );
      return { status: "saved" };
    }
    if (result.status === "duplicate") return { status: "duplicate", name: result.name };
    if (result.status === "invalid") {
      return result.index === undefined
        ? { status: "invalid" }
        : { status: "invalid", index: result.index };
    }
    return { status: result.status };
  } catch {
    return { status: "error" };
  }
}

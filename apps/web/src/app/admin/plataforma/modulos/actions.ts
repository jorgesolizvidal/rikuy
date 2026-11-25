"use server";

import {
  addEmbedOrigin,
  changeTenantModules,
  listPlatformTenants,
  removeEmbedOrigin,
  type ModuleKey,
} from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { refreshPortal } from "@/server/portal-cache";

// The database re-checks the operator and its second factor. No redirects: the client
// refreshes on success.

export interface ModulesState {
  readonly status:
    "idle" | "updated" | "invalid" | "requires" | "not_found" | "forbidden" | "error";
  readonly modules?: readonly ModuleKey[];
  readonly module?: ModuleKey;
  readonly needs?: ModuleKey;
}

export async function changeModulesAction(
  _previous: ModulesState,
  formData: FormData,
): Promise<ModulesState> {
  try {
    if ((await currentAdminActor()) === null) return { status: "forbidden" };
    const { platform } = await adminSession();
    const tenantId = formData.get("tenantId");
    const result = await changeTenantModules(platform, tenantId, formData.getAll("module"));
    if (result.status === "requires") return result;
    if (result.status !== "updated") return { status: result.status };
    // Its portal shows the change on the next visit: the pages of that municipality only.
    if (typeof tenantId === "string") {
      await refreshPortal(
        async (id) =>
          (await listPlatformTenants(platform))?.find((tenant) => tenant.tenantId === id)
            ?.canonicalHost ?? null,
        tenantId,
      );
    }
    return { status: "updated", modules: result.modules };
  } catch {
    return { status: "error" };
  }
}

export interface EmbedOriginsState {
  readonly status:
    "idle" | "added" | "removed" | "invalid" | "too_many" | "not_found" | "forbidden" | "error";
}

/**
 * The websites where a municipality's assistant may be embedded (ADR-071). Only the operator
 * with the second factor (the database checks it again); a change reaches every instance of
 * the proxy within a minute (the registry's cache).
 */
export async function changeEmbedOriginAction(
  _previous: EmbedOriginsState,
  formData: FormData,
): Promise<EmbedOriginsState> {
  try {
    if ((await currentAdminActor()) === null) return { status: "forbidden" };
    const { platformEmbed } = await adminSession();
    const tenantId = formData.get("tenantId");
    const removing = formData.get("intent") === "remove";
    const result = removing
      ? await removeEmbedOrigin(platformEmbed, tenantId, formData.get("origin"))
      : await addEmbedOrigin(platformEmbed, tenantId, formData.get("origin"));
    if (result.status === "updated") return { status: removing ? "removed" : "added" };
    return { status: result.status };
  } catch {
    return { status: "error" };
  }
}

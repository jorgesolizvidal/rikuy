/**
 * White-label configuration against a REAL local Supabase stack: the owner publishes a new
 * brand through the use cases, the anonymous portal read switches to it, and the other
 * tenant is untouched. Roles and isolation are checked against the database itself.
 */
import { publishBranding, type OrganizationMembership, type TenantPresentation } from "@rikuy/core";
import { beforeAll, describe, expect, it } from "vitest";

import { signIn, stackAvailable, env, USERS } from "./integration/local-stack";
import { createSupabasePresentationReader } from "./tenant-config";
import { createSupabaseTenantDirectory } from "./tenant-directory";

const NORTE = "5eed1000-0000-4000-8000-000000000001";

// Built lazily: without stack credentials the suite is skipped and no client may be created.
let anonymousClients:
  | {
      directory: ReturnType<typeof createSupabaseTenantDirectory>;
      reader: ReturnType<typeof createSupabasePresentationReader>;
    }
  | undefined;

function anonymous() {
  anonymousClients ??= {
    directory: createSupabaseTenantDirectory({ url: env.url, publishableKey: env.publishableKey }),
    reader: createSupabasePresentationReader({ url: env.url, publishableKey: env.publishableKey }),
  };
  return anonymousClients;
}

async function portalPresentation(host: string) {
  const tenant = await anonymous().directory.findByHost(host);
  if (tenant?.activeConfigId == null) throw new Error(`No published config for ${host}`);
  const record = await anonymous().reader.findPublished(tenant.activeConfigId);
  return {
    configId: tenant.activeConfigId,
    presentation: record?.presentation as TenantPresentation,
  };
}

describe.runIf(stackAvailable)("tenant branding against local Supabase", () => {
  let owner: Awaited<ReturnType<typeof signIn>>;
  let ownerMembership: OrganizationMembership;

  beforeAll(async () => {
    owner = await signIn(USERS.ownerNorte);
    const [membership] = await owner.reader.listActiveMemberships(owner.actor.userId);
    if (!membership) throw new Error("owner has no membership");
    ownerMembership = membership;
  });

  it("publishing switches the public brand of one tenant only", async () => {
    const before = await portalPresentation("demo-norte.localhost");
    const sur = await portalPresentation("demo-sur.localhost");

    const snapshot = await owner.config.loadSnapshot(NORTE);
    expect(snapshot.portalHostname).toBe("demo-norte.localhost");

    const rebrand: TenantPresentation = {
      ...before.presentation,
      identity: { ...before.presentation.identity, tagline: "Edición de prueba de integración" },
      theme: { mode: "dark", brand: "#f0a868", accent: "#7fb7d9" },
    };
    const result = await publishBranding(
      ownerMembership,
      rebrand,
      snapshot.draft?.revision ?? null,
      owner.config,
    );
    expect(result.status).toBe("published");

    try {
      const after = await portalPresentation("demo-norte.localhost");
      expect(after.configId).not.toBe(before.configId);
      expect(after.presentation.theme.mode).toBe("dark");
      expect(after.presentation.identity.tagline).toBe("Edición de prueba de integración");
      // The superseded version is no longer public.
      expect(await anonymous().reader.findPublished(before.configId)).toBeNull();
      // Demo Sur keeps its own brand.
      expect(await portalPresentation("demo-sur.localhost")).toEqual(sur);
    } finally {
      // Restore the seeded look as a new version so local environments stay recognizable.
      const restored = await publishBranding(
        ownerMembership,
        before.presentation,
        null,
        owner.config,
      );
      expect(restored.status).toBe("published");
    }
  });

  it("the database refuses writes from roles and tenants that may not manage the brand", async () => {
    const both = await signIn(USERS.both); // editor in Demo Norte
    const presentation = (await portalPresentation("demo-norte.localhost")).presentation;
    expect(await both.config.saveDraft(NORTE, presentation, null)).toEqual({ status: "forbidden" });

    const sur = await signIn(USERS.ownerSur);
    expect(await sur.config.saveDraft(NORTE, presentation, null)).toEqual({ status: "forbidden" });
    // RLS: the owner of another tenant sees nothing of Demo Norte's configuration.
    expect(await sur.config.loadSnapshot(NORTE)).toEqual({
      published: null,
      draft: null,
      portalHostname: null,
    });
  });

  it("concurrent edits of the draft are detected", async () => {
    const presentation = (await portalPresentation("demo-norte.localhost")).presentation;
    const first = await owner.config.saveDraft(NORTE, presentation, null);
    expect(first.status).toBe("saved");
    if (first.status !== "saved") return;

    // A second editor that still believes no draft exists, or holds an old revision.
    expect(await owner.config.saveDraft(NORTE, presentation, null)).toEqual({ status: "conflict" });
    const second = await owner.config.saveDraft(NORTE, presentation, first.revision);
    expect(second).toMatchObject({ status: "saved", revision: first.revision + 1 });
    expect(await owner.config.publish(NORTE, first.configId, first.revision)).toEqual({
      status: "conflict",
    });

    // Leave no open draft behind: publish the (unchanged) latest revision.
    if (second.status === "saved") {
      expect(await owner.config.publish(NORTE, second.configId, second.revision)).toMatchObject({
        status: "published",
      });
    }
  });
});

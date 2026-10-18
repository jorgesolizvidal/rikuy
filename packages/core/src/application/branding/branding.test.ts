import { describe, expect, it } from "vitest";

import type { OrganizationMembership } from "../../contracts/organization";
import { samplePresentation } from "../../testing/presentation-fixture";
import type { PortalTenant } from "../../contracts/tenant";
import {
  canManageBranding,
  loadBrandingEditor,
  publishBranding,
  resolvePortalPresentation,
  saveBrandingDraft,
} from "./branding";
import { createCachedPresentationReader } from "./cached-presentation-reader";
import { buildWebManifest, isPortalIconSize, portalIconPath } from "./manifest";
import type { PublishedPresentationReader, TenantConfigRepository } from "./ports";

const TENANT = "5eed1000-0000-4000-8000-000000000001";
const CONFIG = "5eed3000-0000-4000-8000-000000000001";

function member(role: OrganizationMembership["role"]): OrganizationMembership {
  return {
    tenantId: TENANT,
    slug: "demo-norte",
    displayName: "Municipio Demo Norte",
    role,
    tenantStatus: "active",
  };
}

function repository(overrides: Partial<TenantConfigRepository> = {}) {
  const calls: string[] = [];
  const repo: TenantConfigRepository = {
    async loadSnapshot() {
      return { published: null, draft: null, portalHostname: null };
    },
    async saveDraft(_tenant, _presentation, expected) {
      calls.push(`save:${expected}`);
      return { status: "saved", configId: CONFIG, version: 2, revision: (expected ?? 0) + 1 };
    },
    async publish(_tenant, configId, revision) {
      calls.push(`publish:${configId}:${revision}`);
      return { status: "published", configId, version: 2 };
    },
    ...overrides,
  };
  return { repo, calls };
}

function tenant(activeConfigId: string | null): PortalTenant {
  return {
    tenantId: TENANT,
    slug: "demo-norte",
    displayName: "Municipio Demo Norte",
    defaultLocale: "es",
    timezone: "America/La_Paz",
    canonicalHost: "demo-norte.localhost",
    isCanonical: true,
    activeConfigId,
  };
}

describe("branding permissions", () => {
  it("lets only owners and admins manage the brand", () => {
    expect(
      ["owner", "admin", "editor", "analyst"].map((r) => canManageBranding(r as never)),
    ).toEqual([true, true, false, false]);
  });

  it.each(["editor", "analyst"] as const)(
    "a %s cannot save or publish (no repository call)",
    async (role) => {
      const { repo, calls } = repository();
      expect((await saveBrandingDraft(member(role), samplePresentation(), null, repo)).status).toBe(
        "forbidden",
      );
      expect((await publishBranding(member(role), samplePresentation(), null, repo)).status).toBe(
        "forbidden",
      );
      expect(calls).toEqual([]);
    },
  );
});

describe("saving and publishing", () => {
  it("never stores invalid input", async () => {
    const { repo, calls } = repository();
    const result = await saveBrandingDraft(
      member("owner"),
      { ...samplePresentation(), theme: { mode: "light", brand: "#ffff00", accent: "#a06f12" } },
      null,
      repo,
    );
    expect(result).toEqual({
      status: "invalid",
      issues: [{ path: "theme.brand", code: "contrast.brandOnBackground" }],
    });
    expect(calls).toEqual([]);
  });

  it("passes the expected revision through and surfaces conflicts", async () => {
    const { repo, calls } = repository({ saveDraft: async () => ({ status: "conflict" }) });
    expect((await saveBrandingDraft(member("admin"), samplePresentation(), 3, repo)).status).toBe(
      "conflict",
    );
    expect(calls).toEqual([]);
    const ok = repository();
    expect(
      await saveBrandingDraft(member("admin"), samplePresentation(), 3, ok.repo),
    ).toMatchObject({
      status: "saved",
      revision: 4,
    });
    expect(ok.calls).toEqual(["save:3"]);
  });

  it("publishes exactly the revision it just saved", async () => {
    const { repo, calls } = repository();
    expect(await publishBranding(member("owner"), samplePresentation(), 5, repo)).toEqual({
      status: "published",
      configId: CONFIG,
      version: 2,
    });
    expect(calls).toEqual(["save:5", `publish:${CONFIG}:6`]);
  });

  it("does not publish when saving fails", async () => {
    const { repo, calls } = repository({ saveDraft: async () => ({ status: "conflict" }) });
    expect((await publishBranding(member("owner"), samplePresentation(), 1, repo)).status).toBe(
      "conflict",
    );
    expect(calls).toEqual([]);
  });
});

describe("editor state", () => {
  it("starts from the draft, then the published version, then defaults", async () => {
    const published = {
      ...samplePresentation(),
      identity: { siteName: "Publicado", shortName: "Pub", tagline: "" },
    };
    const draft = {
      ...samplePresentation(),
      identity: { siteName: "Borrador", shortName: "Bor", tagline: "" },
    };
    const both = repository({
      loadSnapshot: async () => ({
        published: {
          configId: CONFIG,
          version: 1,
          presentation: published,
          sealedAt: "2026-10-17T00:00:00Z",
        },
        draft: {
          configId: "d",
          version: 2,
          revision: 4,
          presentation: draft,
          updatedAt: "2026-10-17T01:00:00Z",
        },
        portalHostname: "demo-norte.localhost",
      }),
    });
    const state = await loadBrandingEditor(member("editor"), both.repo);
    expect(state.initial.identity.siteName).toBe("Borrador");
    expect(state.canEdit).toBe(false);
    expect(state.draft?.revision).toBe(4);
    expect(state.published?.version).toBe(1);

    const none = await loadBrandingEditor(member("owner"), repository().repo);
    expect(none.initial.identity.siteName).toBe("Municipio Demo Norte");
    expect(none.canEdit).toBe(true);
  });
});

describe("portal presentation", () => {
  const reader = (record: unknown, fail = false): PublishedPresentationReader => ({
    async findPublished() {
      if (fail) throw new Error("down");
      return record === null ? null : { schemaVersion: 1, presentation: record };
    },
  });

  it("uses the published version when it is valid", async () => {
    const resolved = await resolvePortalPresentation(tenant(CONFIG), reader(samplePresentation()));
    expect(resolved.source).toBe("published");
    expect(resolved.configId).toBe(CONFIG);
    expect(resolved.palette.brand).toBe("#1f6f4a");
  });

  it.each([
    ["nothing is published", tenant(null), reader(samplePresentation())],
    ["the stored value is unreadable", tenant(CONFIG), reader({ theme: "x" })],
    ["the config is no longer active", tenant(CONFIG), reader(null)],
    ["the read fails", tenant(CONFIG), reader(null, true)],
  ])("falls back to neutral defaults when %s", async (_case, t, r) => {
    const resolved = await resolvePortalPresentation(t, r);
    expect(resolved.source).toBe("default");
    expect(resolved.configId).toBeNull();
    expect(resolved.presentation.identity.siteName).toBe("Municipio Demo Norte");
  });

  it("caches sealed versions forever but never caches misses", async () => {
    let calls = 0;
    let found = false;
    const cached = createCachedPresentationReader({
      async findPublished() {
        calls += 1;
        return found ? { schemaVersion: 1, presentation: {} } : null;
      },
    });
    expect(await cached.findPublished(CONFIG)).toBeNull();
    found = true;
    await Promise.all([cached.findPublished(CONFIG), cached.findPublished(CONFIG)]);
    await cached.findPublished(CONFIG);
    expect(calls).toBe(2);
  });
});

describe("web manifest", () => {
  it("is built from the resolved presentation with versioned icons", async () => {
    const resolved = await resolvePortalPresentation(tenant(CONFIG), {
      findPublished: async () => ({ schemaVersion: 1, presentation: samplePresentation() }),
    });
    const manifest = buildWebManifest(resolved, "es");
    expect(manifest).toMatchObject({
      name: "Municipio Demo Norte",
      short_name: "Demo Norte",
      theme_color: "#1f6f4a",
      background_color: "#f7f8f6",
      start_url: "/",
      display: "standalone",
    });
    expect(manifest.icons.map((icon) => icon.src)).toContain(`/icon/512?v=${CONFIG}`);
    expect(portalIconPath(32, null)).toBe("/icon/32");
    expect(isPortalIconSize(192)).toBe(true);
    expect(isPortalIconSize(64)).toBe(false);
  });
});

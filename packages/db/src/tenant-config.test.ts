import { describe, expect, it } from "vitest";

import { createSessionClient } from "./session-client";
import { createSupabasePresentationReader, createTenantConfigRepository } from "./tenant-config";

const BASE = "http://127.0.0.1:54321";
const TENANT = "5eed1000-0000-4000-8000-000000000001";
const ACTIVE = "5eed3000-0000-4000-8000-000000000001";
const DRAFT = "5eed3000-0000-4000-8000-0000000000d1";
const DOMAIN = "5eed2000-0000-4000-8000-000000000001";

type Route = (url: URL, init: RequestInit) => Response;

function fakeFetch(route: Route) {
  const calls: { url: URL; body: unknown }[] = [];
  const impl: typeof fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    return route(url, init);
  };
  return { impl, calls };
}

function repository(route: Route) {
  const fetch = fakeFetch(route);
  const client = createSessionClient({
    url: BASE,
    publishableKey: "sb_publishable_test",
    secureCookies: false,
    fetch: fetch.impl,
    cookies: { getAll: () => [], setAll: () => undefined },
  });
  return { repo: createTenantConfigRepository(client), calls: fetch.calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const pgError = (code: string, status: number) =>
  json({ code, message: "x", details: null, hint: null }, status);

describe("tenant config repository", () => {
  it("loads the active version, the open draft and the canonical host", async () => {
    const { repo, calls } = repository((url) => {
      if (url.pathname.endsWith("/tenants"))
        return json({ active_config_id: ACTIVE, canonical_domain_id: DOMAIN });
      if (url.pathname.endsWith("/tenant_domains"))
        return json({ hostname: "demo-norte.localhost" });
      return json([
        {
          id: ACTIVE,
          version: 1,
          revision: 1,
          state: "sealed",
          branding: { a: 1 },
          sealed_at: "2026-10-17T00:00:00Z",
          updated_at: "2026-10-17T00:00:00Z",
        },
        {
          id: DRAFT,
          version: 2,
          revision: 3,
          state: "draft",
          branding: { b: 2 },
          sealed_at: null,
          updated_at: "2026-10-17T01:00:00Z",
        },
      ]);
    });
    const snapshot = await repo.loadSnapshot(TENANT);
    expect(snapshot.published).toMatchObject({
      configId: ACTIVE,
      version: 1,
      presentation: { a: 1 },
    });
    expect(snapshot.draft).toMatchObject({ configId: DRAFT, revision: 3, presentation: { b: 2 } });
    expect(snapshot.portalHostname).toBe("demo-norte.localhost");
    const versions = calls.find((c) => c.url.pathname.endsWith("/tenant_config_versions"));
    expect(versions?.url.searchParams.get("tenant_id")).toBe(`eq.${TENANT}`);
    expect(versions?.url.searchParams.get("or")).toBe(`(state.eq.draft,id.eq.${ACTIVE})`);
  });

  it("returns an empty snapshot when the tenant is not visible", async () => {
    const { repo } = repository(() => json(null, 200));
    expect(await repo.loadSnapshot(TENANT)).toEqual({
      published: null,
      draft: null,
      portalHostname: null,
    });
  });

  it("sends the draft with the expected revision", async () => {
    const { repo, calls } = repository(() => json([{ config_id: DRAFT, version: 2, revision: 4 }]));
    expect(await repo.saveDraft(TENANT, { x: 1 } as never, 3)).toEqual({
      status: "saved",
      configId: DRAFT,
      version: 2,
      revision: 4,
    });
    expect(calls[0]?.url.pathname).toBe("/rest/v1/rpc/save_tenant_config_draft");
    expect(calls[0]?.body).toEqual({
      p_tenant_id: TENANT,
      p_branding: { x: 1 },
      p_expected_revision: 3,
    });
  });

  it.each([
    ["42501", 403, "forbidden"],
    ["PT409", 409, "conflict"],
    ["23514", 400, "invalid"],
  ])("maps save error %s to %s", async (code, status, outcome) => {
    const { repo } = repository(() => pgError(code, status));
    expect(await repo.saveDraft(TENANT, {} as never, null)).toEqual({ status: outcome });
  });

  it.each([
    ["PT404", 404, "not_found"],
    ["PT409", 409, "conflict"],
  ])("maps publish error %s to %s", async (code, status, outcome) => {
    const { repo } = repository(() => pgError(code, status));
    expect(await repo.publish(TENANT, DRAFT, 1)).toEqual({ status: outcome });
  });

  it("throws on unexpected database errors instead of guessing", async () => {
    const { repo } = repository(() => pgError("XX000", 500));
    await expect(repo.saveDraft(TENANT, {} as never, null)).rejects.toThrow(/XX000/);
    await expect(repo.publish(TENANT, DRAFT, 1)).rejects.toThrow(/XX000/);
  });

  it("publishes and returns the sealed version", async () => {
    const { repo, calls } = repository(() => json([{ config_id: DRAFT, version: 2 }]));
    expect(await repo.publish(TENANT, DRAFT, 4)).toEqual({
      status: "published",
      configId: DRAFT,
      version: 2,
    });
    expect(calls[0]?.body).toEqual({
      p_tenant_id: TENANT,
      p_config_id: DRAFT,
      p_expected_revision: 4,
    });
  });
});

describe("published presentation reader", () => {
  it("reads anonymously and maps the row", async () => {
    const fetch = fakeFetch(() => json([{ schema_version: 1, branding: { ok: true } }]));
    const reader = createSupabasePresentationReader({
      url: BASE,
      publishableKey: "pk",
      fetch: fetch.impl,
    });
    expect(await reader.findPublished(ACTIVE)).toEqual({
      schemaVersion: 1,
      presentation: { ok: true },
    });
    expect(fetch.calls[0]?.url.pathname).toBe("/rest/v1/rpc/get_published_presentation");
    expect(fetch.calls[0]?.body).toEqual({ p_config_id: ACTIVE });
  });

  it("returns null when nothing is published under that id and throws on errors", async () => {
    const empty = createSupabasePresentationReader({
      url: BASE,
      publishableKey: "pk",
      fetch: fakeFetch(() => json([])).impl,
    });
    expect(await empty.findPublished(ACTIVE)).toBeNull();
    const broken = createSupabasePresentationReader({
      url: BASE,
      publishableKey: "pk",
      fetch: fakeFetch(() => pgError("XX000", 500)).impl,
    });
    await expect(broken.findPublished(ACTIVE)).rejects.toThrow();
  });
});

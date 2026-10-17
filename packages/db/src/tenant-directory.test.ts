import { TenantDirectoryUnavailableError } from "@rikuy/core";
import { describe, expect, it } from "vitest";

import { createSupabaseTenantDirectory } from "./tenant-directory";

const row = {
  tenant_id: "5eed1000-0000-4000-8000-000000000001",
  tenant_slug: "demo-norte",
  display_name: "Municipio Demo Norte",
  default_locale: "es",
  timezone: "America/La_Paz",
  canonical_host: "demo-norte.localhost",
  is_canonical: true,
  active_config_id: null,
};

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; body: unknown; headers: Headers }[] = [];
  const fn: typeof fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      body: init.body ? JSON.parse(String(init.body)) : null,
      headers: new Headers(init.headers),
    });
    return handler(url, init);
  };
  return Object.assign(fn, { calls });
}

const base = { url: "http://127.0.0.1:54321", publishableKey: "sb_publishable_test" };

describe("createSupabaseTenantDirectory", () => {
  it("calls the RPC with the exact host and maps the row", async () => {
    const fetch = fakeFetch(() => Response.json([row]));
    const tenant = await createSupabaseTenantDirectory({ ...base, fetch }).findByHost(
      "demo-norte.localhost",
    );

    expect(fetch.calls[0]?.url).toBe("http://127.0.0.1:54321/rest/v1/rpc/resolve_tenant_by_host");
    expect(fetch.calls[0]?.body).toEqual({ p_host: "demo-norte.localhost" });
    expect(fetch.calls[0]?.headers.get("apikey")).toBe("sb_publishable_test");
    expect(tenant).toEqual({
      tenantId: row.tenant_id,
      slug: "demo-norte",
      displayName: "Municipio Demo Norte",
      defaultLocale: "es",
      timezone: "America/La_Paz",
      canonicalHost: "demo-norte.localhost",
      isCanonical: true,
      activeConfigId: null,
    });
  });

  it("returns null for an unknown host", async () => {
    const fetch = fakeFetch(() => Response.json([]));
    await expect(
      createSupabaseTenantDirectory({ ...base, fetch }).findByHost("x.example.test"),
    ).resolves.toBeNull();
  });

  it("surfaces registry errors as unavailability", async () => {
    const fetch = fakeFetch(() =>
      Response.json({ code: "PGRST000", message: "boom" }, { status: 503 }),
    );
    await expect(
      createSupabaseTenantDirectory({ ...base, fetch }).findByHost("x.example.test"),
    ).rejects.toBeInstanceOf(TenantDirectoryUnavailableError);
  });

  it("surfaces network failures as unavailability", async () => {
    const fetch = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    await expect(
      createSupabaseTenantDirectory({ ...base, fetch }).findByHost("x.example.test"),
    ).rejects.toBeInstanceOf(TenantDirectoryUnavailableError);
  });

  it("rejects malformed rows instead of trusting them", async () => {
    const fetch = fakeFetch(() => Response.json([{ ...row, tenant_id: "nope" }]));
    await expect(
      createSupabaseTenantDirectory({ ...base, fetch }).findByHost("x.example.test"),
    ).rejects.toThrow();
  });

  it("refuses ambiguous results", async () => {
    const fetch = fakeFetch(() => Response.json([row, row]));
    await expect(
      createSupabaseTenantDirectory({ ...base, fetch }).findByHost("x.example.test"),
    ).rejects.toBeInstanceOf(TenantDirectoryUnavailableError);
  });
});

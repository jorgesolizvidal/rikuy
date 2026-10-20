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

  it("tries once more after a transient failure (network, timeout, 5xx)", async () => {
    let attempt = 0;
    const fetch = fakeFetch(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new TypeError("fetch failed")) : Response.json([row]);
    });
    const tenant = await createSupabaseTenantDirectory({ ...base, fetch }).findByHost(
      "demo-norte.localhost",
    );
    expect(fetch.calls).toHaveLength(2);
    expect(tenant?.slug).toBe("demo-norte");
  });

  it("gives up after the second attempt", async () => {
    const fetch = fakeFetch(() =>
      Response.json({ code: "PGRST000", message: "boom" }, { status: 503 }),
    );
    await expect(
      createSupabaseTenantDirectory({ ...base, fetch }).findByHost("x.example.test"),
    ).rejects.toBeInstanceOf(TenantDirectoryUnavailableError);
    expect(fetch.calls).toHaveLength(2);
  });

  it("does not repeat a request the registry refused (4xx)", async () => {
    const fetch = fakeFetch(() =>
      Response.json({ code: "PGRST202", message: "not found" }, { status: 404 }),
    );
    await expect(
      createSupabaseTenantDirectory({ ...base, fetch }).findByHost("x.example.test"),
    ).rejects.toBeInstanceOf(TenantDirectoryUnavailableError);
    expect(fetch.calls).toHaveLength(1);
  });

  it("retries a timed-out lookup", async () => {
    let attempt = 0;
    const fetch = fakeFetch((_url, init) => {
      attempt += 1;
      if (attempt > 1) return Response.json([row]);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    });
    const tenant = await createSupabaseTenantDirectory({
      ...base,
      fetch,
      timeoutMs: 20,
    }).findByHost("demo-norte.localhost");
    expect(fetch.calls).toHaveLength(2);
    expect(tenant?.slug).toBe("demo-norte");
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

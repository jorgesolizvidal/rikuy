import { decodeTenantContext, type PortalTenant, type TenantDirectory } from "@rikuy/core";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { TENANT_CONTEXT_HEADER } from "./internal-headers";
import { createPortalProxy } from "./portal-proxy";

const hosts = { rootDomain: "localhost", adminHost: "app.localhost:3000" };

function tenant(slug: string, overrides: Partial<PortalTenant> = {}): PortalTenant {
  return {
    tenantId:
      slug === "norte"
        ? "5eed1000-0000-4000-8000-000000000001"
        : "5eed1000-0000-4000-8000-000000000002",
    slug,
    displayName: `Municipio ${slug}`,
    defaultLocale: "es",
    timezone: "America/La_Paz",
    canonicalHost: `${slug}.localhost`,
    isCanonical: true,
    activeConfigId: null,
    ...overrides,
  };
}

const registry: Record<string, PortalTenant> = {
  "norte.localhost": tenant("norte"),
  "sur.localhost": tenant("sur"),
  "alias-norte.localhost": tenant("norte", { isCanonical: false }),
};

const directory: TenantDirectory = { findByHost: async (host) => registry[host] ?? null };

function request(url: string, headers: Record<string, string> = {}) {
  const host = new URL(url).host;
  return new NextRequest(url, { headers: { host, ...headers } });
}

/** The URL the proxy rewrote to, as Next.js propagates it. */
function rewrittenPath(response: Response): string | null {
  const target = response.headers.get("x-middleware-rewrite");
  return target === null ? null : new URL(target).pathname + new URL(target).search;
}

/** Request headers the proxy forwards upstream. */
function forwardedHeader(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

const proxy = createPortalProxy({ hosts, directory });

describe("portal proxy", () => {
  it("routes the admin host to the admin surface", async () => {
    const response = await proxy(request("http://app.localhost:3000/settings"));
    expect(rewrittenPath(response)).toBe("/admin/settings");
  });

  it("routes the platform apex to the product site", async () => {
    const response = await proxy(request("http://localhost:3000/"));
    expect(rewrittenPath(response)).toBe("/platform");
  });

  it("resolves a portal host and forwards its tenant context", async () => {
    const response = await proxy(request("http://norte.localhost:3000/eventos?page=2"));
    expect(rewrittenPath(response)).toBe("/portal/norte.localhost/eventos?page=2");
    const context = decodeTenantContext(forwardedHeader(response, TENANT_CONTEXT_HEADER));
    expect(context?.tenant.slug).toBe("norte");
    expect(context?.host).toBe("norte.localhost");
  });

  it("answers 404 noindex for an unknown host — no default tenant", async () => {
    const response = await proxy(request("http://desconocido.localhost:3000/"));
    expect(response.status).toBe(404);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(rewrittenPath(response)).toBeNull();
  });

  it("answers 503 when the registry is unreachable", async () => {
    const down = createPortalProxy({
      hosts,
      directory: { findByHost: () => Promise.reject(new Error("db down")) },
    });
    const response = await down(request("http://norte.localhost:3000/"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
  });

  it("redirects an alias to the canonical host with 308, keeping path and query", async () => {
    const response = await proxy(request("http://alias-norte.localhost:3000/eventos?x=1"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("http://norte.localhost:3000/eventos?x=1");
  });

  it("answers 400 for a malformed host", async () => {
    const response = await proxy(
      new NextRequest("http://x.localhost:3000/", {
        headers: { host: "a.localhost, b.localhost" },
      }),
    );
    expect(response.status).toBe(400);
  });

  it("ignores X-Forwarded-Host and spoofed tenant headers", async () => {
    const spoofed = request("http://norte.localhost:3000/", {
      "x-forwarded-host": "sur.localhost",
      "x-tenant-id": "5eed1000-0000-4000-8000-000000000002",
      [TENANT_CONTEXT_HEADER]: "forged",
      "x-rikuy-anything": "forged",
    });
    const response = await proxy(spoofed);
    const context = decodeTenantContext(forwardedHeader(response, TENANT_CONTEXT_HEADER));
    expect(context?.tenant.slug).toBe("norte");
    expect(forwardedHeader(response, "x-tenant-id")).toBeNull();
    expect(forwardedHeader(response, "x-rikuy-anything")).toBeNull();
  });

  it("strips forged internal headers on admin and platform hosts too", async () => {
    const response = await proxy(
      request("http://app.localhost:3000/", { [TENANT_CONTEXT_HEADER]: "forged" }),
    );
    expect(forwardedHeader(response, TENANT_CONTEXT_HEADER)).toBeNull();
  });

  it("cannot reach internal routes directly: paths are always re-prefixed", async () => {
    const response = await proxy(request("http://norte.localhost:3000/portal/sur.localhost"));
    expect(rewrittenPath(response)).toBe("/portal/norte.localhost/portal/sur.localhost");
    const admin = await proxy(request("http://norte.localhost:3000/admin"));
    expect(rewrittenPath(admin)).toBe("/portal/norte.localhost/admin");
  });

  it("keeps two tenants apart under concurrent requests", async () => {
    const [norte, sur] = await Promise.all([
      proxy(request("http://norte.localhost:3000/")),
      proxy(request("http://sur.localhost:3000/")),
    ]);
    expect(decodeTenantContext(forwardedHeader(norte, TENANT_CONTEXT_HEADER))?.tenant.slug).toBe(
      "norte",
    );
    expect(decodeTenantContext(forwardedHeader(sur, TENANT_CONTEXT_HEADER))?.tenant.slug).toBe(
      "sur",
    );
  });
});

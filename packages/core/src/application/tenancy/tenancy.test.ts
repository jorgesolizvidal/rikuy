import { describe, expect, it, vi } from "vitest";

import type { PortalTenant } from "../../contracts/tenant";
import { createCachedTenantDirectory } from "./cached-tenant-directory";
import { resolvePortalTenant, type TenantDirectory } from "./resolve-portal-tenant";

function tenant(overrides: Partial<PortalTenant> = {}): PortalTenant {
  return {
    tenantId: "aaaaaaaa-0000-4000-8000-000000000001",
    slug: "tenant-a",
    displayName: "Tenant A",
    defaultLocale: "es",
    timezone: "America/La_Paz",
    canonicalHost: "a.example.test",
    isCanonical: true,
    activeConfigId: null,
    ...overrides,
  };
}

function directoryOf(map: Record<string, PortalTenant>): TenantDirectory & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async findByHost(hostname) {
      calls.push(hostname);
      return map[hostname] ?? null;
    },
  };
}

describe("resolvePortalTenant", () => {
  it("returns the context for a canonical host", async () => {
    const result = await resolvePortalTenant(
      "a.example.test",
      directoryOf({ "a.example.test": tenant() }),
    );
    expect(result).toEqual({
      status: "found",
      context: { version: 1, host: "a.example.test", tenant: tenant() },
    });
  });

  it("redirects an alias to the canonical host", async () => {
    const alias = tenant({ isCanonical: false });
    const result = await resolvePortalTenant(
      "alias.a.example.test",
      directoryOf({ "alias.a.example.test": alias }),
    );
    expect(result).toEqual({ status: "redirect", canonicalHost: "a.example.test" });
  });

  it("serves an alias when the tenant has no active canonical host", async () => {
    const alias = tenant({ isCanonical: false, canonicalHost: null });
    const result = await resolvePortalTenant(
      "alias.a.example.test",
      directoryOf({ "alias.a.example.test": alias }),
    );
    expect(result.status).toBe("found");
  });

  it("never falls back to another tenant for unknown hosts", async () => {
    const result = await resolvePortalTenant(
      "unknown.example.test",
      directoryOf({ "a.example.test": tenant() }),
    );
    expect(result).toEqual({ status: "not_found" });
  });

  it("reports unavailability instead of guessing", async () => {
    const failing: TenantDirectory = { findByHost: () => Promise.reject(new Error("db down")) };
    expect(await resolvePortalTenant("a.example.test", failing)).toEqual({ status: "unavailable" });
  });
});

describe("createCachedTenantDirectory", () => {
  it("caches hits for the positive TTL and misses for the negative TTL", async () => {
    let clock = 0;
    const inner = directoryOf({ "a.example.test": tenant() });
    const cached = createCachedTenantDirectory(inner, {
      positiveTtlMs: 60_000,
      negativeTtlMs: 10_000,
      now: () => clock,
    });

    await cached.findByHost("a.example.test");
    await cached.findByHost("a.example.test");
    await cached.findByHost("unknown.example.test");
    await cached.findByHost("unknown.example.test");
    expect(inner.calls).toEqual(["a.example.test", "unknown.example.test"]);

    clock = 10_001;
    await cached.findByHost("unknown.example.test");
    await cached.findByHost("a.example.test");
    expect(inner.calls).toEqual(["a.example.test", "unknown.example.test", "unknown.example.test"]);

    clock = 60_001;
    await cached.findByHost("a.example.test");
    expect(inner.calls.at(-1)).toBe("a.example.test");
  });

  it("does not cache errors", async () => {
    const findByHost = vi
      .fn<TenantDirectory["findByHost"]>()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(tenant());
    const cached = createCachedTenantDirectory({ findByHost });
    await expect(cached.findByHost("a.example.test")).rejects.toThrow("timeout");
    await expect(cached.findByHost("a.example.test")).resolves.toEqual(tenant());
  });

  it("coalesces concurrent lookups of the same host", async () => {
    const inner = directoryOf({ "a.example.test": tenant() });
    const cached = createCachedTenantDirectory(inner);
    await Promise.all([cached.findByHost("a.example.test"), cached.findByHost("a.example.test")]);
    expect(inner.calls).toEqual(["a.example.test"]);
  });

  it("keys entries by exact host, so tenants never share a cache entry", async () => {
    const b = tenant({
      tenantId: "bbbbbbbb-0000-4000-8000-000000000001",
      slug: "tenant-b",
      canonicalHost: "b.example.test",
    });
    const cached = createCachedTenantDirectory(
      directoryOf({ "a.example.test": tenant(), "b.example.test": b }),
    );
    const [ra, rb] = await Promise.all([
      cached.findByHost("a.example.test"),
      cached.findByHost("b.example.test"),
    ]);
    expect(ra?.slug).toBe("tenant-a");
    expect(rb?.slug).toBe("tenant-b");
  });

  it("evicts the oldest entry when full", async () => {
    const inner = directoryOf({});
    const cached = createCachedTenantDirectory(inner, { maxEntries: 2 });
    for (const host of ["1.example.test", "2.example.test", "3.example.test", "1.example.test"]) {
      await cached.findByHost(host);
    }
    expect(inner.calls).toEqual([
      "1.example.test",
      "2.example.test",
      "3.example.test",
      "1.example.test",
    ]);
  });
});

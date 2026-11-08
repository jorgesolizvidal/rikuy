import { describe, expect, it } from "vitest";

import type { MetricsOverview, TenantMetrics } from "../../contracts/metrics";
import { encodeTenantContext } from "../../contracts/tenant";
import { cleanErrorMessage, describeServerError } from "../../domain/metrics/telemetry";
import type { OperatorAccess, PlatformRepository } from "../platform/ports";
import {
  checkPublicationNow,
  loadMetricsOverview,
  loadTenantMetrics,
  normalizeErrorSearch,
  planPortalProbe,
  runPortalProbe,
  type MetricsRepository,
} from "./metrics";

const TENANT = "5eed1000-0000-4000-8000-000000000001";
const REQUEST = "11111111-2222-4333-8444-555555555555";

describe("what a server error records (ADR-044)", () => {
  const context = encodeTenantContext({
    version: 1,
    host: "demo-norte.localhost",
    tenant: {
      tenantId: TENANT,
      slug: "demo-norte",
      displayName: "Demo Norte",
      defaultLocale: "es",
      timezone: "America/La_Paz",
      canonicalHost: "demo-norte.localhost",
      isCanonical: true,
      activeConfigId: null,
    },
  });

  it("takes the portal's municipality from the proxy's context, and the route pattern", () => {
    const error = Object.assign(new TypeError("falló https://x.test/a?token=secreto"), {
      digest: "12345",
    });
    expect(
      describeServerError({
        path: "/portal/demo-norte.localhost/destinos/mirador?x=1",
        method: "get",
        headers: {
          "x-rikuy-request-id": REQUEST,
          "x-rikuy-tenant-context": context,
          cookie: "s=1",
        },
        routePath: "/portal/[host]/destinos/[slug]",
        error,
      }),
    ).toEqual({
      requestId: REQUEST,
      digest: "12345",
      surface: "portal",
      tenantId: TENANT,
      slug: null,
      route: "/portal/[host]/destinos/[slug]",
      method: "GET",
      kind: "TypeError",
      message: "falló https://x.test/a?…",
    });
  });

  it("tells the portal by its route pattern when Next reports the visitor's address", () => {
    expect(
      describeServerError({
        path: "/mapa",
        method: "GET",
        headers: { "x-rikuy-request-id": REQUEST, "x-rikuy-tenant-context": context },
        routePath: "/portal/[host]/mapa",
        error: new Error("x"),
      }),
    ).toMatchObject({
      surface: "portal",
      tenantId: TENANT,
      slug: null,
      route: "/portal/[host]/mapa",
    });
    expect(
      describeServerError({
        path: "/o/demo-sur/miembros",
        method: "GET",
        headers: {},
        routePath: "/admin/o/[slug]/miembros",
        error: new Error("x"),
      }),
    ).toMatchObject({ surface: "admin", slug: "demo-sur" });
  });

  it("takes the panel's municipality from /o/{slug}, and never trusts odd values", () => {
    const record = describeServerError({
      path: "/admin/o/demo-sur/miembros",
      method: "P0ST!",
      headers: { "x-rikuy-request-id": "no-es-un-id" },
      routePath: "no es una ruta",
      error: "algo",
    });
    expect(record).toMatchObject({
      requestId: null,
      digest: null,
      surface: "admin",
      tenantId: null,
      slug: "demo-sur",
      route: "/",
      method: "GET",
      kind: "Error",
      message: "algo",
    });
    expect(
      describeServerError({
        path: "/platform/api/jobs/drain",
        method: "POST",
        headers: {},
        error: new Error("x"),
      }).surface,
    ).toBe("platform");
  });

  it("cuts messages at the query string and at 300 characters", () => {
    expect(cleanErrorMessage("a?b=c d")).toBe("a?… d");
    expect(cleanErrorMessage("x".repeat(400))).toHaveLength(300);
  });
});

describe("the operator's readings", () => {
  const overview: MetricsOverview = {
    generatedAt: "2026-11-08T00:00:00Z",
    platformErrors: { last24h: 0, last7d: 0 },
    tenants: [
      {
        tenantId: TENANT,
        slug: "demo-norte",
        displayName: "Demo Norte",
        status: "active",
        errors24h: 1,
        requests24h: 3,
        p95Ms24h: 800,
        jobsFailed7d: 0,
        jobsWaiting: 0,
        aiCalls7d: 0,
        aiCostUsd7d: 0,
        probe: null,
        check: null,
      },
    ],
  };
  const detail = { generatedAt: overview.generatedAt } as TenantMetrics;
  const platform = (access: OperatorAccess) =>
    ({ operatorAccess: async () => access }) as unknown as PlatformRepository;
  const calls: string[] = [];
  const metrics: MetricsRepository = {
    overview: async () => overview,
    tenant: async (id) => (id === TENANT ? detail : null),
    async errors(id, search) {
      calls.push(`errors:${id}:${search}`);
      return [];
    },
    async checkPublication(id) {
      calls.push(`check:${id}`);
      return "checked";
    },
  };

  it("only an operator with a second factor reads anything", async () => {
    expect(await loadMetricsOverview(platform("needs_mfa"), metrics)).toBeNull();
    expect(await loadTenantMetrics(platform("none"), metrics, "demo-norte", null)).toEqual({
      status: "forbidden",
    });
    expect(await checkPublicationNow(platform("needs_mfa"), metrics, TENANT)).toBe("forbidden");
    expect(calls).toEqual([]);
  });

  it("finds a municipality by its slug and searches its errors", async () => {
    expect(await loadTenantMetrics(platform("ok"), metrics, "otro", null)).toEqual({
      status: "not_found",
    });
    const found = await loadTenantMetrics(platform("ok"), metrics, "demo-norte", "  abc-123 ");
    expect(found).toMatchObject({ status: "found", search: "abc-123" });
    expect(calls).toContain(`errors:${TENANT}:abc-123`);
    expect(normalizeErrorSearch("a b")).toBeNull();
    expect(normalizeErrorSearch("x".repeat(65))).toBeNull();
    expect(await checkPublicationNow(platform("ok"), metrics, "no")).toBe("not_found");
    expect(await checkPublicationNow(platform("ok"), metrics, TENANT)).toBe("checked");
  });
});

describe("the daily probe of a portal", () => {
  const origins = {
    portalOrigin: (host: string) => `https://${host}`,
    publicMediaBase: "https://ref.supabase.co/",
  };

  it("times the home, /mapa and the latest public image", () => {
    expect(
      planPortalProbe({ host: "demo.vercel.app", mediaPath: `${TENANT}/a/1/w480.webp` }, origins),
    ).toEqual([
      { target: "home", url: "https://demo.vercel.app/", path: "/" },
      { target: "map", url: "https://demo.vercel.app/mapa", path: "/mapa" },
      {
        target: "media",
        url: `https://ref.supabase.co/storage/v1/object/public/media-public/${TENANT}/a/1/w480.webp`,
        path: `media-public/${TENANT}/a/1/w480.webp`,
      },
    ]);
    expect(planPortalProbe({ host: "demo.vercel.app", mediaPath: null }, origins)).toHaveLength(2);
  });

  it("records failures with their reason instead of throwing", async () => {
    const plan = planPortalProbe({ host: "demo.vercel.app", mediaPath: null }, origins);
    let call = 0;
    const results = await runPortalProbe(plan, async () => {
      call += 1;
      if (call === 2) throw Object.assign(new Error("slow"), { name: "TimeoutError" });
      return { status: 200, ttfbMs: 80.4, totalMs: 120.6, bytes: 9000, cache: "HIT" };
    });
    expect(results).toEqual([
      {
        target: "home",
        path: "/",
        status: 200,
        ttfbMs: 80,
        totalMs: 121,
        bytes: 9000,
        cache: "HIT",
        error: null,
      },
      {
        target: "map",
        path: "/mapa",
        status: null,
        ttfbMs: null,
        totalMs: null,
        bytes: null,
        cache: null,
        error: "timeout",
      },
    ]);
  });
});

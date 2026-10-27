import { describe, expect, it } from "vitest";

import {
  svgDataUri,
  createInvitationRepository,
  createMemberRepository,
  createPlatformRepository,
  createSupabaseIdentityAdmin,
} from "./platform";
import { createSessionClient } from "./session-client";

const BASE = "http://127.0.0.1:54321";
const TENANT = "5eed1000-0000-4000-8000-000000000001";
const USER = "5eed0000-0000-4000-8000-000000000009";

type Route = (url: URL, body: unknown, init: RequestInit) => Response;

function fakeFetch(route: Route) {
  const calls: { url: URL; body: unknown; headers: Headers }[] = [];
  const impl: typeof fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, headers: new Headers(init.headers) });
    return route(url, body, init);
  };
  return { impl, calls };
}

function session(route: Route) {
  const f = fakeFetch(route);
  const client = createSessionClient({
    url: BASE,
    publishableKey: "sb_publishable_test",
    secureCookies: false,
    fetch: f.impl,
    cookies: { getAll: () => [], setAll: () => undefined },
  });
  return { client, calls: f.calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const pgError = (code: string, status: number, hint: string | null = null) =>
  json({ code, message: "x", details: null, hint }, status);

describe("platform repository", () => {
  it("reads the operator status", async () => {
    const { client } = session(() => json("needs_mfa"));
    expect(await createPlatformRepository(client).operatorAccess()).toBe("needs_mfa");
  });

  it("provisions with every field and maps conflicts by hint", async () => {
    const ok = session(() => json([{ tenant_id: TENANT, domain_id: TENANT }]));
    const request = {
      slug: "demo-este",
      displayName: "Municipio Demo Este",
      hostname: "demo-este.localhost",
      ownerUserId: USER,
      defaultLocale: "es",
      timezone: "America/La_Paz",
      demo: false,
    };
    expect(await createPlatformRepository(ok.client).provision(request)).toEqual({
      status: "provisioned",
      tenantId: TENANT,
    });
    expect(ok.calls[0]?.url.pathname).toBe("/rest/v1/rpc/provision_tenant");
    expect(ok.calls[0]?.body).toMatchObject({ p_slug: "demo-este", p_owner_user_id: USER });
    // A real municipality does not send the demo flag (works before and after ADR-034).
    expect(ok.calls[0]?.body).not.toHaveProperty("p_demo");
    const demo = session(() => json([{ tenant_id: TENANT, domain_id: TENANT }]));
    await createPlatformRepository(demo.client).provision({ ...request, demo: true });
    expect(demo.calls[0]?.body).toMatchObject({ p_demo: true });

    for (const [code, status, hint, outcome] of [
      ["PT409", 409, "slug", "slug_taken"],
      ["PT409", 409, "hostname", "hostname_taken"],
      ["PT404", 404, "owner", "owner_not_found"],
      ["42501", 403, null, "forbidden"],
      ["23514", 400, null, "invalid"],
    ] as const) {
      const failing = session(() => pgError(code, status, hint));
      expect(await createPlatformRepository(failing.client).provision(request)).toEqual({
        status: outcome,
      });
    }
  });

  it("maps status changes", async () => {
    const pending = session(() => pgError("PT409", 409, "owner_pending"));
    expect(await createPlatformRepository(pending.client).setStatus(TENANT, "active")).toEqual({
      status: "owner_pending",
    });
    const transition = session(() => pgError("PT409", 409, "status"));
    expect(await createPlatformRepository(transition.client).setStatus(TENANT, "active")).toEqual({
      status: "invalid_transition",
    });
  });
});

describe("members and invitations", () => {
  it("maps member errors", async () => {
    const lastOwner = session(() => pgError("PT409", 409, "last_owner"));
    expect(await createMemberRepository(lastOwner.client).revoke(TENANT, USER)).toEqual({
      status: "last_owner",
    });
    const already = session(() => pgError("PT409", 409, "already_member"));
    expect(await createMemberRepository(already.client).add(TENANT, USER, "editor")).toEqual({
      status: "already_member",
    });
    const broken = session(() => pgError("XX000", 500));
    await expect(
      createMemberRepository(broken.client).changeRole(TENANT, USER, "editor"),
    ).rejects.toThrow(/XX000/);
  });

  it("accepts invitations and reports missing ones", async () => {
    const missing = session(() => pgError("PT404", 404, "invitation"));
    expect(await createInvitationRepository(missing.client).accept(TENANT)).toBe("not_found");
    const ok = session(() => new Response(null, { status: 204 }));
    expect(await createInvitationRepository(ok.client).accept(TENANT)).toBe("accepted");
  });
});

describe("identity admin", () => {
  it("reuses an existing account without creating a new one", async () => {
    const f = fakeFetch(() => json(USER));
    const admin = createSupabaseIdentityAdmin({
      url: BASE,
      secretKey: "sb_secret_test",
      fetch: f.impl,
    });
    expect(await admin.ensureUser("x@example.test")).toEqual({ userId: USER, created: false });
    expect(f.calls.map((c) => c.url.pathname)).toEqual(["/rest/v1/rpc/platform_user_id_by_email"]);
    expect(f.calls[0]?.headers.get("apikey")).toBe("sb_secret_test");
  });

  it("creates a confirmed, passwordless account for a new email", async () => {
    const f = fakeFetch((url) =>
      url.pathname.startsWith("/rest/")
        ? json(null)
        : json({ id: USER, email: "x@example.test", aud: "authenticated" }),
    );
    const admin = createSupabaseIdentityAdmin({
      url: BASE,
      secretKey: "sb_secret_test",
      fetch: f.impl,
    });
    expect(await admin.ensureUser("x@example.test")).toEqual({ userId: USER, created: true });
    const create = f.calls.find((c) => c.url.pathname === "/auth/v1/admin/users");
    expect(create?.body).toEqual({ email: "x@example.test", email_confirm: true });
  });
});

describe("TOTP QR codes", () => {
  it("percent-encodes the SVG so colors with # do not truncate the image", () => {
    const raw = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#000"/></svg>';
    for (const input of [raw, `data:image/svg+xml;utf-8,${raw}`]) {
      const uri = svgDataUri(input);
      expect(uri.startsWith("data:image/svg+xml;charset=utf-8,%3Csvg")).toBe(true);
      expect(uri).not.toContain("#");
      expect(decodeURIComponent(uri.split(",")[1] ?? "")).toBe(raw);
    }
    expect(svgDataUri("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });
});

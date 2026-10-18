import { describe, expect, it } from "vitest";

import { createSupabaseAuthGateway } from "./auth-gateway";
import { createMembershipReader } from "./membership-reader";
import { createSessionClient, hasSessionCookies, type SessionCookieToSet } from "./session-client";

const URL_BASE = "http://127.0.0.1:54321";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

const accessToken = [
  b64url({ alg: "HS256", typ: "JWT" }),
  b64url({ sub: USER_ID, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }),
  "signature",
].join(".");

const session = {
  access_token: accessToken,
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: "refresh-token",
  user: { id: USER_ID, aud: "authenticated", role: "authenticated", email: "owner@example.test" },
};

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

function harness(route: Route, secureCookies = false) {
  const jar = new Map<string, string>();
  const written: SessionCookieToSet[] = [];
  const headersWritten: Record<string, string>[] = [];
  const requests: { url: URL; method: string; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    requests.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers) });
    return route(url, init);
  };
  const client = createSessionClient({
    url: URL_BASE,
    publishableKey: "sb_publishable_test",
    secureCookies,
    fetch: fetchImpl,
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll(cookies, headers) {
        for (const cookie of cookies) {
          written.push(cookie);
          if (cookie.value === "") jar.delete(cookie.name);
          else jar.set(cookie.name, cookie.value);
        }
        headersWritten.push(headers);
      },
    },
  });
  return {
    client,
    gateway: createSupabaseAuthGateway(client),
    jar,
    written,
    headersWritten,
    requests,
  };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("auth gateway", () => {
  it("requests a code without creating users and with the admin callback", async () => {
    const h = harness(() => json({}));
    expect(
      await h.gateway.requestEmailCode("owner@example.test", {
        redirectTo: "http://app.localhost:3000/auth/callback",
      }),
    ).toBe("sent");
    const call = h.requests.find((r) => r.url.pathname === "/auth/v1/otp");
    expect(call).toBeDefined();
    expect(call?.url.searchParams.get("redirect_to")).toBe(
      "http://app.localhost:3000/auth/callback",
    );
  });

  it.each([
    [422, "otp_disabled", "not_allowed"],
    [400, "validation_failed", "not_allowed"],
    [429, "over_email_send_rate_limit", "rate_limited"],
    [500, "unexpected_failure", "unavailable"],
    [422, "email_provider_disabled", "unavailable"],
  ])("maps HTTP %s (%s) to %s", async (status, code, outcome) => {
    const h = harness(() => json({ code, msg: "x", error_code: code }, status));
    expect(await h.gateway.requestEmailCode("x@example.test", { redirectTo: "http://x" })).toBe(
      outcome,
    );
  });

  it("stores the session in host-only, HttpOnly, SameSite=Lax cookies and forbids caching", async () => {
    const h = harness(
      (url) => (url.pathname === "/auth/v1/verify" ? json(session) : json({}, 404)),
      true,
    );
    expect(await h.gateway.verifyEmailCode("owner@example.test", "123456")).toBe("signed_in");

    const sessionCookie = h.written.find((c) => c.name.includes("-auth-token") && c.value !== "");
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: true,
    });
    expect(sessionCookie?.options).not.toHaveProperty("domain");
    expect(
      h.headersWritten.some((headers) =>
        /no-store/.test(headers["Cache-Control"] ?? headers["cache-control"] ?? ""),
      ),
    ).toBe(true);
    expect(hasSessionCookies([...h.jar].map(([name, value]) => ({ name, value })))).toBe(true);
  });

  it("reports an invalid code without a session", async () => {
    const h = harness(() =>
      json({ code: "otp_expired", msg: "Token has expired or is invalid" }, 403),
    );
    expect(await h.gateway.verifyEmailCode("owner@example.test", "000000")).toBe("invalid_code");
    expect(h.jar.size).toBe(0);
  });

  it("has no actor without a session and never calls the network for it", async () => {
    const h = harness(() => json({}, 500));
    expect(await h.gateway.currentActor()).toBeNull();
  });

  it("returns the actor verified by the provider", async () => {
    const h = harness((url) => {
      if (url.pathname === "/auth/v1/verify") return json(session);
      if (url.pathname === "/auth/v1/user") return json(session.user);
      return json({}, 404);
    });
    await h.gateway.verifyEmailCode("owner@example.test", "123456");
    expect(await h.gateway.currentActor()).toEqual({
      userId: USER_ID,
      email: "owner@example.test",
    });
  });
});

describe("membership reader", () => {
  it("filters by the actor id and active status and hides suspended tenants", async () => {
    const h = harness((url) => {
      if (url.pathname === "/rest/v1/memberships") {
        return json([
          {
            role: "owner",
            tenant: {
              id: "5eed1000-0000-4000-8000-000000000001",
              slug: "norte",
              display_name: "Norte",
              status: "active",
            },
          },
          {
            role: "admin",
            tenant: {
              id: "5eed1000-0000-4000-8000-000000000003",
              slug: "x",
              display_name: "X",
              status: "suspended",
            },
          },
          {
            role: "owner",
            tenant: {
              id: "5eed1000-0000-4000-8000-000000000004",
              slug: "nuevo",
              display_name: "Nuevo",
              status: "provisioning",
            },
          },
        ]);
      }
      return json({}, 404);
    });
    const result = await createMembershipReader(h.client).listActiveMemberships(USER_ID);

    const call = h.requests.find((r) => r.url.pathname === "/rest/v1/memberships");
    expect(call?.url.searchParams.get("user_id")).toBe(`eq.${USER_ID}`);
    expect(call?.url.searchParams.get("status")).toBe("eq.active");
    expect(result).toEqual([
      {
        tenantId: "5eed1000-0000-4000-8000-000000000001",
        slug: "norte",
        displayName: "Norte",
        role: "owner",
        tenantStatus: "active",
      },
      {
        tenantId: "5eed1000-0000-4000-8000-000000000004",
        slug: "nuevo",
        displayName: "Nuevo",
        role: "owner",
        tenantStatus: "provisioning",
      },
    ]);
  });

  it("fails loudly on errors instead of returning an empty list", async () => {
    const h = harness(() => json({ code: "42501", message: "denied" }, 403));
    await expect(createMembershipReader(h.client).listActiveMemberships(USER_ID)).rejects.toThrow();
  });
});

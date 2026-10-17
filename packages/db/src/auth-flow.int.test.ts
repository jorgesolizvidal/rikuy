/**
 * End-to-end sign-in against a REAL local Supabase stack (GoTrue + PostgREST + Mailpit),
 * using the seeded synthetic users. Run with `pnpm --filter @rikuy/db test:integration`
 * after `pnpm db:start`, or in the CI job "Auth integration".
 */
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { createSupabaseAuthGateway } from "./auth-gateway";
import { createMembershipReader } from "./membership-reader";
import { createSessionClient } from "./session-client";

const env = {
  url: process.env.SUPABASE_URL ?? "http://127.0.0.1:54321",
  publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
  secretKey: process.env.SUPABASE_SECRET_KEY ?? "",
  mailpit: process.env.MAILPIT_URL ?? "http://127.0.0.1:54324",
};

if (process.env.CI && env.publishableKey === "") {
  throw new Error("SUPABASE_PUBLISHABLE_KEY is required for integration tests in CI");
}

const REDIRECT = "http://app.localhost:3000/auth/callback";
const USERS = {
  ownerNorte: "owner@demo-norte.example.test",
  ownerSur: "owner@demo-sur.example.test",
  both: "editor.ambos@example.test",
  revoked: "revocado@demo-norte.example.test",
  unknown: "nadie@example.test",
};

function newSession() {
  const jar = new Map<string, string>();
  const client = createSessionClient({
    url: env.url,
    publishableKey: env.publishableKey,
    secureCookies: false,
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll(cookies) {
        for (const { name, value } of cookies) {
          if (value === "") jar.delete(name);
          else jar.set(name, value);
        }
      },
    },
  });
  return {
    client,
    gateway: createSupabaseAuthGateway(client),
    reader: createMembershipReader(client),
    jar,
  };
}

async function mailpit(path: string, init?: RequestInit) {
  const response = await fetch(`${env.mailpit}/api/v1${path}`, init);
  if (!response.ok) throw new Error(`Mailpit ${path}: ${response.status}`);
  // Some endpoints (e.g. DELETE /messages) answer with plain text "ok".
  const body = await response.text();
  return response.headers.get("content-type")?.includes("json")
    ? (JSON.parse(body) as unknown)
    : null;
}

async function latestCodeFor(email: string, since: number, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const search = (await mailpit(`/search?query=${encodeURIComponent(`to:"${email}"`)}`)) as {
      messages?: { ID: string; Created: string }[];
    };
    // Only emails sent after this request: earlier codes for the same user are already used.
    const id = search.messages?.find((m) => Date.parse(m.Created) >= since - 1_000)?.ID;
    if (id) {
      const message = (await mailpit(`/message/${id}`)) as { Text?: string; HTML?: string };
      const code = /\b(\d{6})\b/.exec(`${message.Text ?? ""} ${message.HTML ?? ""}`)?.[1];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No sign-in email for ${email}`);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function signIn(email: string) {
  const session = newSession();
  // GoTrue enforces a minimum interval between emails to the same address.
  await pause(1_100);
  const since = Date.now();
  expect(await session.gateway.requestEmailCode(email, { redirectTo: REDIRECT })).toBe("sent");
  const code = await latestCodeFor(email, since);
  expect(await session.gateway.verifyEmailCode(email, code)).toBe("signed_in");
  const actor = await session.gateway.currentActor();
  if (actor === null) throw new Error(`No session after verifying the code for ${email}`);
  expect(actor.email).toBe(email);
  return { ...session, actor };
}

describe.runIf(env.publishableKey !== "")("sign-in against local Supabase", () => {
  beforeAll(async () => {
    await mailpit("/messages", { method: "DELETE" });
  });

  it("signs in a provisioned owner by email code and lists only their municipality", async () => {
    const { reader, actor, client } = await signIn(USERS.ownerNorte);
    expect((await reader.listActiveMemberships(actor.userId)).map((m) => [m.slug, m.role])).toEqual(
      [["demo-norte", "owner"]],
    );

    // RLS: the session can read its own tenant and nothing of the other one.
    const { data } = await client.from("tenants").select("slug");
    expect(data?.map((t) => t.slug)).toEqual(["demo-norte"]);
  });

  it("lists both municipalities for a member of two tenants, each with its own role", async () => {
    const { reader, actor } = await signIn(USERS.both);
    const memberships = await reader.listActiveMemberships(actor.userId);
    expect(memberships.map((m) => [m.slug, m.role]).sort()).toEqual([
      ["demo-norte", "editor"],
      ["demo-sur", "analyst"],
    ]);
  });

  it("a revoked member can sign in but sees no municipality", async () => {
    const { reader, actor } = await signIn(USERS.revoked);
    expect(await reader.listActiveMemberships(actor.userId)).toEqual([]);
  });

  it("revocation applies immediately to an already signed-in session", async () => {
    const { reader, actor } = await signIn(USERS.ownerSur);
    expect(await reader.listActiveMemberships(actor.userId)).toHaveLength(1);

    const admin = createClient(env.url, env.secretKey, { auth: { persistSession: false } });
    const both = await signIn(USERS.both);
    const revoke = await admin
      .from("memberships")
      .update({ status: "revoked", revoked_at: new Date().toISOString() })
      .eq("user_id", both.actor.userId)
      .eq("tenant_id", "5eed1000-0000-4000-8000-000000000001");
    expect(revoke.error).toBeNull();

    try {
      // Same session, same (still valid) JWT: access to demo-norte is gone.
      expect(
        (await both.reader.listActiveMemberships(both.actor.userId)).map((m) => m.slug),
      ).toEqual(["demo-sur"]);
    } finally {
      await admin
        .from("memberships")
        .update({ status: "active", revoked_at: null })
        .eq("user_id", both.actor.userId)
        .eq("tenant_id", "5eed1000-0000-4000-8000-000000000001");
    }
  });

  it("does not send email to unknown addresses (sign-ups are disabled)", async () => {
    const { gateway } = newSession();
    expect(await gateway.requestEmailCode(USERS.unknown, { redirectTo: REDIRECT })).toBe(
      "not_allowed",
    );
    await pause(1_000);
    const search = (await mailpit(
      `/search?query=${encodeURIComponent(`to:"${USERS.unknown}"`)}`,
    )) as {
      messages?: unknown[];
    };
    expect(search.messages ?? []).toHaveLength(0);
  });

  it("rejects a wrong code and signing out removes the session", async () => {
    const wrong = newSession();
    expect(await wrong.gateway.requestEmailCode(USERS.ownerNorte, { redirectTo: REDIRECT })).toBe(
      "sent",
    );
    expect(await wrong.gateway.verifyEmailCode(USERS.ownerNorte, "000000")).toBe("invalid_code");

    const session = await signIn(USERS.ownerNorte);
    await session.gateway.signOut();
    expect(await session.gateway.currentActor()).toBeNull();
  });
});

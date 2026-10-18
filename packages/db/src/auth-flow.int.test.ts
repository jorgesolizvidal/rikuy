/**
 * End-to-end sign-in against a REAL local Supabase stack (GoTrue + PostgREST + Mailpit),
 * using the seeded synthetic users. Run with `pnpm --filter @rikuy/db test:integration`
 * after `pnpm db:start`, or in the CI job "Integration".
 */
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  env,
  mailpit,
  newSession,
  pause,
  REDIRECT,
  signIn,
  stackAvailable,
  USERS,
} from "./integration/local-stack";

describe.runIf(stackAvailable)("sign-in against local Supabase", () => {
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

/**
 * Helpers for integration suites that run against a REAL local Supabase stack
 * (GoTrue + PostgREST + Mailpit) with the seeded synthetic users.
 */
import { expect } from "vitest";

import { createSupabaseAuthGateway } from "../auth-gateway";
import { createMembershipReader } from "../membership-reader";
import { createSessionClient } from "../session-client";
import { createTenantConfigRepository } from "../tenant-config";
import { totp } from "./totp";

export const env = {
  url: process.env.SUPABASE_URL ?? "http://127.0.0.1:54321",
  publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
  secretKey: process.env.SUPABASE_SECRET_KEY ?? "",
  mailpit: process.env.MAILPIT_URL ?? "http://127.0.0.1:54324",
};

if (process.env.CI && env.publishableKey === "") {
  throw new Error("SUPABASE_PUBLISHABLE_KEY is required for integration tests in CI");
}

export const REDIRECT = "http://app.localhost:3000/auth/callback";
export const USERS = {
  ownerNorte: "owner@demo-norte.example.test",
  ownerSur: "owner@demo-sur.example.test",
  both: "editor.ambos@example.test",
  revoked: "revocado@demo-norte.example.test",
  unknown: "nadie@example.test",
};

export function newSession() {
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
    config: createTenantConfigRepository(client),
    jar,
  };
}

export async function mailpit(path: string, init?: RequestInit) {
  const response = await fetch(`${env.mailpit}/api/v1${path}`, init);
  if (!response.ok) throw new Error(`Mailpit ${path}: ${response.status}`);
  // Some endpoints (e.g. DELETE /messages) answer with plain text "ok".
  const body = await response.text();
  return response.headers.get("content-type")?.includes("json")
    ? (JSON.parse(body) as unknown)
    : null;
}

export async function latestCodeFor(
  email: string,
  since: number,
  timeoutMs = 15_000,
): Promise<string> {
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

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * TOTP secret of the seeded demo owners (supabase/seed.sql). Synthetic, local only: owners
 * and admins act only with a second factor (ADR-043).
 */
export const SEED_TOTP_SECRET = "JBSWY3DPEHPK3PXP";

/**
 * Raises a signed-in session to aal2 with the seeded factor, the way the panel does after
 * the person types the code of their app. Returns false when the user has no factor.
 */
export async function passSecondFactor(
  client: ReturnType<typeof newSession>["client"],
  secret = SEED_TOTP_SECRET,
): Promise<boolean> {
  const { data, error } = await client.auth.mfa.listFactors();
  if (error) throw new Error(`Listing factors: ${error.message}`);
  const factor = data.totp[0];
  if (!factor) return false;
  // Auth accepts the codes of the windows next to the current one. If a code was already
  // used in this window (the suites sign the same owner in again within seconds), the
  // neighbour windows still work.
  let last = "";
  for (const offset of [0, 30_000, -30_000]) {
    const verified = await client.auth.mfa.challengeAndVerify({
      factorId: factor.id,
      code: totp(secret, Date.now() + offset),
    });
    if (!verified.error) return true;
    last = verified.error.message;
  }
  throw new Error(`Second factor: ${last}`);
}

/**
 * Signs in with the email code. People with a factor (the seeded owners) also pass the
 * second factor unless `secondFactor: false`, to test what a session without it can do.
 */
export async function signIn(email: string, options: { readonly secondFactor?: boolean } = {}) {
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
  if (options.secondFactor !== false) await passSecondFactor(session.client);
  return { ...session, actor };
}

/** True when the stack credentials are present (CI sets them; locally they are optional). */
export const stackAvailable = env.publishableKey !== "";

/**
 * Helpers for integration suites that run against a REAL local Supabase stack
 * (GoTrue + PostgREST + Mailpit) with the seeded synthetic users.
 */
import { expect } from "vitest";

import { createSupabaseAuthGateway } from "../auth-gateway";
import { createMembershipReader } from "../membership-reader";
import { createSessionClient } from "../session-client";
import { createTenantConfigRepository } from "../tenant-config";

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

export async function signIn(email: string) {
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

/** True when the stack credentials are present (CI sets them; locally they are optional). */
export const stackAvailable = env.publishableKey !== "";

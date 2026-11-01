/**
 * The AI gateway (P5 · Paso 1, ADR-036) against a REAL PostgreSQL, through the dedicated
 * role rikuy_ai: a request is reserved, answered and settled; eight requests at once, each
 * on its own connection, never pass the municipality's quota together; and with the quota
 * used up the provider is never called while the portal keeps answering visitors.
 */
import {
  createSimulatedAiProvider,
  PROBE_MESSAGES,
  reservationFor,
  runAiRequest,
  type AiProvider,
} from "@rikuy/core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresAiLedger } from "./ai-ledger";
import { createSupabasePublishedContentReader } from "./content";
import { env, stackAvailable } from "./integration/local-stack";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// Demo Sur (seed). Demo Norte stays untouched for RC-15.
const SUR = "5eed1000-0000-4000-8000-000000000002";
const RESERVE = reservationFor("probe", PROBE_MESSAGES);

const admin = postgres(DB_URL, { max: 2, prepare: false, onnotice: () => undefined });
const reachable = await admin`select 1`.then(
  () => true,
  () => false,
);
if (process.env.CI && !reachable) throw new Error(`The database at ${DB_URL} is not reachable`);

const ledgerOf = () => createPostgresAiLedger({ url: DB_URL, role: "rikuy_ai", maxConnections: 1 });

async function aiBucket() {
  // Created on first use: in its own statement, so the next one sees it.
  const [bucket] =
    await admin`select private.current_usage_bucket(${SUR}::uuid, 'ai_tokens') as id`;
  const [row] = await admin`
    select b.limit_amount, b.reserved, b.consumed from public.usage_buckets b where b.id = ${bucket?.id}::uuid
  `;
  return {
    limit: Number(row?.limit_amount),
    reserved: Number(row?.reserved),
    consumed: Number(row?.consumed),
  };
}

async function setAiLimit(limit: number) {
  await admin`
    insert into public.tenant_quotas (tenant_id, resource, limit_amount) values (${SUR}::uuid, 'ai_tokens', ${limit})
    on conflict (tenant_id, resource) do update set limit_amount = excluded.limit_amount
  `;
  await admin`
    update public.usage_buckets set limit_amount = ${limit}
    where id = private.current_usage_bucket(${SUR}::uuid, 'ai_tokens')
  `;
}

describe.runIf(reachable)("the AI gateway (real PostgreSQL, role rikuy_ai)", () => {
  beforeAll(async () => {
    await admin`update public.tenants set status = 'active' where id = ${SUR}::uuid`;
  });

  afterAll(async () => {
    await admin`delete from public.tenant_quotas where tenant_id = ${SUR}::uuid and resource = 'ai_tokens'`;
    await admin`
      update public.usage_buckets set limit_amount = private.quota_default('ai_tokens')
      where id = private.current_usage_bucket(${SUR}::uuid, 'ai_tokens')
    `;
    await admin.end({ timeout: 5 });
  });

  it("reserves, answers and settles what the call really used", async () => {
    const before = await aiBucket();
    const ledger = ledgerOf();
    try {
      const result = await runAiRequest(
        { tenantId: SUR, profile: "probe", messages: PROBE_MESSAGES },
        { ledger, provider: createSimulatedAiProvider() },
      );
      expect(result.outcome).toBe("answered");
      if (result.outcome !== "answered") return;
      const after = await aiBucket();
      expect(after.reserved).toBe(before.reserved);
      expect(after.consumed - before.consumed).toBe(
        result.usage.inputTokens + result.usage.outputTokens,
      );
      expect(after.consumed - before.consumed).toBeLessThan(RESERVE);
      const [request] = await admin`
        select r.status, r.outcome, (select count(*)::int from public.ai_executions e where e.request_id = r.id) as calls
        from public.ai_requests r where r.id = ${result.requestId}::uuid
      `;
      expect(request).toEqual({ status: "completed", outcome: "answered", calls: 1 });
    } finally {
      await ledger.close();
    }
  });

  it("never lets eight requests at once pass the municipality's quota", async () => {
    const now = await aiBucket();
    await setAiLimit(now.consumed + now.reserved + 3 * RESERVE + Math.floor(RESERVE / 2));
    const ledgers = Array.from({ length: 8 }, ledgerOf);
    try {
      const begun = await Promise.all(
        ledgers.map(async (ledger) => ({
          ledger,
          ...(await ledger.begin({
            tenantId: SUR,
            profile: "probe",
            reserveTokens: RESERVE,
            visitor: null,
            actorId: null,
          })),
        })),
      );
      expect(begun.filter((request) => request.outcome === "reserved")).toHaveLength(3);
      expect(begun.filter((request) => request.outcome === "tenant_quota")).toHaveLength(5);
      const bucket = await aiBucket();
      expect(bucket.consumed + bucket.reserved).toBeLessThanOrEqual(bucket.limit);
      // Settle the three (nothing answered): their reservations are given back.
      await Promise.all(
        begun
          .filter((request) => request.outcome === "reserved")
          .map((request) => request.ledger.finish(request.requestId, "provider_unavailable", [])),
      );
      expect((await aiBucket()).reserved).toBe(now.reserved);
    } finally {
      await Promise.all(ledgers.map((ledger) => ledger.close()));
    }
  });

  it("with the quota used up, stops the AI before the provider while the portal keeps working", async () => {
    const now = await aiBucket();
    await setAiLimit(now.consumed + now.reserved);
    let calls = 0;
    const provider: AiProvider = {
      ...createSimulatedAiProvider(),
      async complete() {
        calls += 1;
        throw new Error("the provider must not be called");
      },
    };
    const ledger = ledgerOf();
    try {
      const result = await runAiRequest(
        {
          tenantId: SUR,
          profile: "assistant",
          messages: [{ role: "user", content: "¿Qué visitar hoy?" }],
          visitor: "198.51.100.4",
        },
        { ledger, provider },
      );
      expect(result.outcome).toBe("tenant_quota");
      expect(calls).toBe(0);
    } finally {
      await ledger.close();
    }
    if (stackAvailable) {
      const portal = createSupabasePublishedContentReader({
        url: env.url,
        publishableKey: env.publishableKey,
      });
      expect((await portal.list(SUR)).length).toBeGreaterThan(0);
    }
  });
});

/**
 * Dictation (P5 · Paso 6, ADR-041) against a REAL PostgreSQL, through the dedicated role
 * rikuy_ai: a recording is reserved, transcribed and settled with the seconds billed; eight
 * dictations at once, each on its own connection, never pass the municipality's daily
 * seconds together; and with the seconds used up the provider is never called.
 */
import {
  createSimulatedTranscriber,
  DICTATION_LIMITS,
  SIMULATED_DICTATION,
  transcribeDictation,
  type SpeechTranscriber,
} from "@rikuy/core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresAiLedger } from "./ai-ledger";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// Demo Sur (seed). Demo Norte stays untouched for RC-15.
const SUR = "5eed1000-0000-4000-8000-000000000002";
const RESERVE = DICTATION_LIMITS.reserveSeconds;

const admin = postgres(DB_URL, { max: 2, prepare: false, onnotice: () => undefined });
const reachable = await admin`select 1`.then(
  () => true,
  () => false,
);
if (process.env.CI && !reachable) throw new Error(`The database at ${DB_URL} is not reachable`);

const ledgerOf = () => createPostgresAiLedger({ url: DB_URL, role: "rikuy_ai", maxConnections: 1 });

/** A WAV of ~64 KB (4 s for the simulated transcriber). */
function recording(): Uint8Array {
  const bytes = new Uint8Array(64 * 1024);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  return bytes;
}

async function voiceBucket() {
  const [bucket] =
    await admin`select private.current_usage_bucket(${SUR}::uuid, 'ai_audio_seconds') as id`;
  const [row] = await admin`
    select b.limit_amount, b.reserved, b.consumed from public.usage_buckets b where b.id = ${bucket?.id}::uuid
  `;
  return {
    limit: Number(row?.limit_amount),
    reserved: Number(row?.reserved),
    consumed: Number(row?.consumed),
  };
}

async function setVoiceLimit(limit: number) {
  await admin`
    insert into public.tenant_quotas (tenant_id, resource, limit_amount) values (${SUR}::uuid, 'ai_audio_seconds', ${limit})
    on conflict (tenant_id, resource) do update set limit_amount = excluded.limit_amount
  `;
  await admin`
    update public.usage_buckets set limit_amount = ${limit}
    where id = private.current_usage_bucket(${SUR}::uuid, 'ai_audio_seconds')
  `;
}

describe.runIf(reachable)("dictation (real PostgreSQL, role rikuy_ai)", () => {
  beforeAll(async () => {
    await admin`update public.tenants set status = 'active' where id = ${SUR}::uuid`;
  });

  afterAll(async () => {
    await admin`delete from public.tenant_quotas where tenant_id = ${SUR}::uuid and resource = 'ai_audio_seconds'`;
    await admin`
      update public.usage_buckets set limit_amount = private.quota_default('ai_audio_seconds')
      where id = private.current_usage_bucket(${SUR}::uuid, 'ai_audio_seconds')
    `;
    await admin`delete from public.ai_requests where tenant_id = ${SUR}::uuid and profile = 'dictation'`;
    await admin.end({ timeout: 5 });
  });

  it("reserves, transcribes and settles the seconds billed (at least 10)", async () => {
    const before = await voiceBucket();
    const ledger = ledgerOf();
    try {
      const { reply, trace } = await transcribeDictation(
        { tenantId: SUR, audio: recording(), visitor: "203.0.113.50", prompt: null },
        { ledger, transcriber: createSimulatedTranscriber() },
      );
      expect(reply).toEqual({ status: "transcribed", text: SIMULATED_DICTATION });
      expect(trace).toEqual({ outcome: "transcribed", billedSeconds: 10, attempts: 1 });
    } finally {
      await ledger.close();
    }
    const after = await voiceBucket();
    expect(after.consumed - before.consumed).toBe(10);
    expect(after.reserved).toBe(before.reserved);
    const [request] = await admin`
      select status, outcome, audio_seconds, reserved_tokens from public.ai_requests
      where tenant_id = ${SUR}::uuid and profile = 'dictation' order by created_at desc limit 1
    `;
    expect(request).toMatchObject({
      status: "completed",
      outcome: "transcribed",
      audio_seconds: "10",
      reserved_tokens: "0",
    });
  });

  it("never lets eight dictations at once pass the municipality's seconds", async () => {
    const now = await voiceBucket();
    await setVoiceLimit(now.consumed + now.reserved + 3 * RESERVE + Math.floor(RESERVE / 2));
    const ledgers = Array.from({ length: 8 }, ledgerOf);
    try {
      const begun = await Promise.all(
        ledgers.map(async (ledger) => ({
          ledger,
          ...(await ledger.beginDictation({
            tenantId: SUR,
            reserveSeconds: RESERVE,
            visitor: null,
          })),
        })),
      );
      expect(begun.filter((request) => request.outcome === "reserved")).toHaveLength(3);
      expect(begun.filter((request) => request.outcome === "tenant_quota")).toHaveLength(5);
      const bucket = await voiceBucket();
      expect(bucket.consumed + bucket.reserved).toBeLessThanOrEqual(bucket.limit);
      await Promise.all(
        begun
          .filter((request) => request.outcome === "reserved")
          .map((request) =>
            request.ledger.finishDictation(request.requestId, "provider_unavailable", []),
          ),
      );
      expect((await voiceBucket()).reserved).toBe(now.reserved);
    } finally {
      await Promise.all(ledgers.map((ledger) => ledger.close()));
    }
  });

  it("with the seconds used up, stops before the provider", async () => {
    const now = await voiceBucket();
    await setVoiceLimit(now.consumed + now.reserved);
    let calls = 0;
    const transcriber: SpeechTranscriber = {
      ...createSimulatedTranscriber(),
      async transcribe() {
        calls += 1;
        throw new Error("the provider must not be called");
      },
    };
    const ledger = ledgerOf();
    try {
      const { reply, trace } = await transcribeDictation(
        { tenantId: SUR, audio: recording(), visitor: "198.51.100.40", prompt: null },
        { ledger, transcriber },
      );
      expect(trace.outcome).toBe("tenant_quota");
      expect(reply.status).toBe("notice");
      expect(calls).toBe(0);
    } finally {
      await ledger.close();
    }
  });
});

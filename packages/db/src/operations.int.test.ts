/**
 * Operation on free plans against a REAL local Supabase stack (ADR-035): an unused photo is
 * removed from both buckets of real Storage (list + remove) by the runner's processor, its
 * quota is freed, a used one is left alone, and the runner's daily report parses.
 */
import { randomUUID } from "node:crypto";

import { drainJobs } from "@rikuy/core";
import { createRemoveUnusedMediaProcessor } from "@rikuy/worker";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { env, stackAvailable } from "./integration/local-stack";
import { createPostgresJobLedger } from "./job-ledger";
import { createSupabaseMediaAdmin, MEDIA_BUCKETS } from "./media";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";

describe.runIf(stackAvailable)("operation on free plans against local Supabase", () => {
  const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
  const admin = createSupabaseMediaAdmin({ url: env.url, secretKey: env.secretKey });
  const unused = { asset: randomUUID(), version: randomUUID() };
  const kept = { asset: randomUUID(), version: randomUUID() };
  const folderOf = (asset: string) => `${SUR}/${asset}/1/`;

  beforeAll(async () => {
    if (env.secretKey === "") throw new Error("SUPABASE_SECRET_KEY is required");
    for (const [media, age] of [
      [unused, "8 days"],
      [kept, "1 day"],
    ] as const) {
      await db`insert into public.assets (id, tenant_id, purpose) values (${media.asset}, ${SUR}, 'content')`;
      await db`
        insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                           mime, bytes, width, height, sha256, ready_at)
        values (${media.version}, ${SUR}, ${media.asset}, 1, 'ready', 'image/jpeg', 1000, 'image/jpeg', 1000,
                1600, 1067, ${"c".repeat(64)}, now() - ${age}::interval)
      `;
      const bytes = new Uint8Array([1, 2, 3, 4]);
      await admin.storeDerivatives(folderOf(media.asset), [
        { name: "original", bytes, contentType: "image/webp" },
        { name: "w480.webp", bytes, contentType: "image/webp" },
        { name: "w960.webp", bytes, contentType: "image/webp" },
      ]);
    }
  });

  afterAll(async () => {
    await db.end({ timeout: 5 });
  });

  it("removes an unused photo from real Storage and frees its quota, and keeps a fresh one", async () => {
    const [sweep] = await db`select private.enqueue_unused_media_jobs() as created`;
    expect(sweep?.created).toBeGreaterThanOrEqual(1);
    const jobs = await db`
      select subject_id from public.background_jobs where kind = 'media.remove_unused' and tenant_id = ${SUR}
    `;
    expect(jobs.map((job) => job.subject_id)).toContain(unused.version);
    expect(jobs.map((job) => job.subject_id)).not.toContain(kept.version);

    const ledger = createPostgresJobLedger({
      url: DB_URL,
      role: "rikuy_worker",
      maxConnections: 2,
    });
    try {
      await drainJobs({
        ledger,
        processors: [
          createRemoveUnusedMediaProcessor({ unusedMedia: ledger.unusedMedia, folders: admin }),
        ],
        runnerId: "it-unused",
        budgetMs: 15_000,
      });
    } finally {
      await ledger.close();
    }

    const [version] =
      await db`select status, rejected_reason from public.asset_versions where id = ${unused.version}`;
    expect(version).toEqual({
      status: "rejected",
      rejected_reason: "Sin uso: se liberó su espacio.",
    });
    const left = await db`
      select count(*)::int as n from storage.objects
      where bucket_id = ${MEDIA_BUCKETS.originals} and name like ${`${folderOf(unused.asset)}%`}
    `;
    expect(left[0]?.n).toBe(0);
    const keptFiles = await db`
      select count(*)::int as n from storage.objects
      where bucket_id = ${MEDIA_BUCKETS.originals} and name like ${`${folderOf(kept.asset)}%`}
    `;
    expect(keptFiles[0]?.n).toBe(3);
    const [reservation] = await db`
      select consumed from public.usage_reservations where asset_version_id = ${unused.version} and resource = 'storage_bytes'
    `;
    expect(Number(reservation?.consumed ?? 0)).toBe(0);
  });

  it("gives the runner the daily report", async () => {
    const ledger = createPostgresJobLedger({
      url: DB_URL,
      role: "rikuy_worker",
      maxConnections: 1,
    });
    try {
      const report = await ledger.operationsReport();
      expect(report.storage.limit).toBe(1_073_741_824);
      expect(report.storage.bytes).toBeGreaterThan(0);
      expect(report.operators).toContain("operador@rikuy.example.test");
    } finally {
      await ledger.close();
    }
  });
});

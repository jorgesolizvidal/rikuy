/**
 * Quotas under concurrency (P2 · Paso 5), against a REAL PostgreSQL: several people of the
 * same municipality request uploads at the same moment, each on its own connection, as
 * `authenticated` with their JWT claims (what PostgREST does). Together they never pass the
 * quota: the reservation is one conditional UPDATE on the bucket row.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// Demo Sur and its owner (seed). Demo Norte stays untouched for RC-15.
const SUR = "5eed1000-0000-4000-8000-000000000002";
const OWNER = "5eed0000-0000-4000-8000-000000000002";
const MB = 1024 * 1024;

const admin = postgres(DB_URL, { max: 2, prepare: false, onnotice: () => undefined });
const reachable = await admin`select 1`.then(
  () => true,
  () => false,
);
if (process.env.CI && !reachable) throw new Error(`The database at ${DB_URL} is not reachable`);

/** One person's request on its own connection, as PostgREST would run it. */
async function requestUpload(
  holdMs = 0,
): Promise<{ ok: true; versionId: string } | { ok: false; code: string; hint: string }> {
  const sql = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    return await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER, role: "authenticated" })}, true)`;
      await tx`set local role authenticated`;
      const [row] = await tx`
        select version_id from public.create_image_upload(${SUR}::uuid, 'content', 'image/jpeg', ${10 * MB})
      `;
      if (holdMs > 0) await tx`select pg_sleep(${holdMs / 1000})`;
      return { ok: true as const, versionId: String(row?.version_id) };
    });
  } catch (error) {
    const value = error as { code?: string; hint?: string };
    return { ok: false, code: value.code ?? "", hint: value.hint ?? "" };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function storage() {
  const [row] = await admin`
    select b.limit_amount, b.reserved, b.consumed from public.usage_buckets b
    where b.tenant_id = ${SUR}::uuid and b.resource = 'storage_bytes'
  `;
  return {
    limit: Number(row?.limit_amount),
    reserved: Number(row?.reserved),
    consumed: Number(row?.consumed),
  };
}

describe.runIf(reachable)("quotas under concurrency (real PostgreSQL)", () => {
  const created: string[] = [];
  let previousLimit: number | null = null;

  beforeAll(async () => {
    await admin`update public.tenants set status = 'active' where id = ${SUR}::uuid`;
    // Make sure the bucket exists, then leave room for exactly three 10 MB photos (15 MB each).
    await admin`select private.current_usage_bucket(${SUR}::uuid, 'storage_bytes')`;
    const [quota] = await admin`
      select limit_amount from public.tenant_quotas where tenant_id = ${SUR}::uuid and resource = 'storage_bytes'
    `;
    previousLimit = quota ? Number(quota.limit_amount) : null;
    const now = await storage();
    const limit = now.consumed + now.reserved + 45 * MB + MB / 2;
    await admin`
      insert into public.tenant_quotas (tenant_id, resource, limit_amount) values (${SUR}::uuid, 'storage_bytes', ${limit})
      on conflict (tenant_id, resource) do update set limit_amount = excluded.limit_amount
    `;
    await admin`update public.usage_buckets set limit_amount = ${limit} where tenant_id = ${SUR}::uuid and resource = 'storage_bytes'`;
  });

  afterAll(async () => {
    // Abandon what the test reserved (the trigger gives it back) and restore the limit.
    if (created.length > 0) {
      await admin`
        update public.asset_versions set status = 'rejected', rejected_reason = 'test_cleanup'
        where id = any(string_to_array(${created.join(",")}, ',')::uuid[]) and status = 'uploading'
      `;
    }
    if (previousLimit === null) {
      await admin`delete from public.tenant_quotas where tenant_id = ${SUR}::uuid and resource = 'storage_bytes'`;
    } else {
      await admin`update public.tenant_quotas set limit_amount = ${previousLimit} where tenant_id = ${SUR}::uuid and resource = 'storage_bytes'`;
    }
    await admin`
      update public.usage_buckets set limit_amount = private.quota_limit(${SUR}::uuid, 'storage_bytes')
      where tenant_id = ${SUR}::uuid and resource = 'storage_bytes'
    `;
    await admin.end({ timeout: 5 });
  });

  it("lets exactly as many concurrent uploads in as the quota holds", async () => {
    const before = await storage();
    // Eight people at once; each keeps its transaction open a moment, so they really overlap.
    const results = await Promise.all(Array.from({ length: 8 }, () => requestUpload(300)));
    const accepted = results.filter((result) => result.ok);
    const refused = results.filter((result) => !result.ok);
    for (const result of accepted) if (result.ok) created.push(result.versionId);

    expect(accepted).toHaveLength(3);
    expect(refused).toHaveLength(5);
    for (const result of refused)
      expect(result).toMatchObject({ code: "PT507", hint: "storage_bytes" });
    const after = await storage();
    expect(after.reserved - before.reserved).toBe(3 * 15 * MB);
    expect(after.consumed + after.reserved).toBeLessThanOrEqual(after.limit);
  });

  it("a request that waits behind another sees its reservation", async () => {
    // The room left is less than one photo: the waiting request must be refused.
    const first = requestUpload(500);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await requestUpload();
    const result = await first;
    expect(result.ok ? "accepted" : result.code).toBe("PT507");
    expect(second.ok ? "accepted" : second.code).toBe("PT507");
  });

  it("rejecting an upload gives its room back to the next one", async () => {
    const victim = created.pop();
    if (!victim) throw new Error("no upload to reject");
    await admin`update public.asset_versions set status = 'rejected', rejected_reason = 'test' where id = ${victim}::uuid`;
    const next = await requestUpload();
    expect(next.ok).toBe(true);
    if (next.ok) created.push(next.versionId);
  });
});

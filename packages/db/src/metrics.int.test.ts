/**
 * Metrics per municipality (ADR-044) against a REAL local Supabase stack:
 *
 * - the web app's telemetry, through the workload's role (rikuy_worker), records an error
 *   and the latency of a route, and the operator (with a second factor) reads them back;
 * - the daily probe reads its target and records its results only under a job's lease;
 * - nobody else reads metrics: an owner gets 42501 through the Data API, and worker_api is
 *   not exposed by PostgREST at all.
 */
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, env, stackAvailable, USERS } from "./integration/local-stack";
import { createPostgresJobLedger } from "./job-ledger";
import { createMetricsRepository } from "./metrics";
import { createPostgresTelemetry } from "./telemetry";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const OPERATOR = "5eed0000-0000-4000-8000-000000000005";

describe.runIf(stackAvailable)("metrics per municipality against local Supabase", () => {
  const admin = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
  const telemetry = createPostgresTelemetry({ url: DB_URL, role: "rikuy_worker" });
  const ledger = createPostgresJobLedger({ url: DB_URL, role: "rikuy_worker", maxConnections: 1 });

  /** The operator's readings, as the RPC sees an operator session with a second factor. */
  async function asOperator<T>(work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return (await admin.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OPERATOR, role: "authenticated", aal: "aal2" })}, true)`;
      await tx`set local role authenticated`;
      return work(tx);
    })) as T;
  }

  beforeAll(async () => {
    await admin`update public.tenants set status = 'active' where id = ${SUR}::uuid`;
  });

  afterAll(async () => {
    await telemetry.close();
    await ledger.close();
    await admin.end({ timeout: 5 });
  });

  it("records an error and a route's latency through the workload's role", async () => {
    const requestId = randomUUID();
    const digest = `d${Date.now().toString(36)}`;
    await telemetry.recordError({
      requestId,
      digest,
      surface: "portal",
      tenantId: SUR,
      slug: null,
      route: "/portal/[host]/destinos/[slug]",
      method: "GET",
      kind: "TypeError",
      message: "falló https://x.test/a?token=secreto",
    });
    await telemetry.recordLatency({ tenantId: SUR, route: "map_places", ms: 120, status: 200 });

    const rows = await asOperator(
      (tx) => tx`select * from public.platform_tenant_errors(${SUR}::uuid, ${digest})`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      request_id: requestId,
      surface: "portal",
      kind: "TypeError",
      message: "falló https://x.test/a?…",
    });

    const [detail] = await asOperator(
      (tx) => tx`select public.platform_tenant_metrics(${SUR}::uuid) as m`,
    );
    const routes = (detail?.m as { routes: { route: string; period: string; requests: number }[] })
      .routes;
    expect(
      routes.find((route) => route.route === "map_places" && route.period === "24h")?.requests,
    ).toBeGreaterThanOrEqual(1);
  });

  it("records anonymous visit counts through the workload's role (ADR-051)", async () => {
    const visitor = `9.9.9.${Math.floor(Math.random() * 200)}|Chrome`;
    const before = await admin<{ views: number }[]>`
      select coalesce(sum(views), 0)::int as views from public.visit_daily_counts
      where tenant_id = ${SUR}::uuid and target = 'destination' and event = 'view'`;
    for (let i = 0; i < 2; i += 1) {
      await telemetry.recordVisit({
        tenantId: SUR,
        target: "destination",
        slug: "laguna-espejo",
        sceneId: null,
        event: "view",
        country: "BO",
        city: "Cliza",
        visitor,
      });
    }
    // Not published here: ignored, and nothing breaks.
    await telemetry.recordVisit({
      tenantId: SUR,
      target: "destination",
      slug: "no-existe",
      sceneId: null,
      event: "view",
      country: null,
      city: null,
      visitor,
    });
    const after = await admin<{ views: number }[]>`
      select coalesce(sum(views), 0)::int as views from public.visit_daily_counts
      where tenant_id = ${SUR}::uuid and target = 'destination' and event = 'view'`;
    expect((after[0]?.views ?? 0) - (before[0]?.views ?? 0)).toBe(2);
    const [origin] = await admin<{ views: number }[]>`
      select views from public.visit_daily_origins
      where tenant_id = ${SUR}::uuid and country = 'BO' and city = 'Cliza'
        and day = (now() at time zone 'America/La_Paz')::date`;
    expect(origin?.views).toBeGreaterThanOrEqual(2);
  });

  it("the daily probe reads its target and records under the job's lease", async () => {
    await admin`delete from public.background_jobs where kind = 'metrics.probe_portal' and status = 'pending'`;
    await admin`select private.enqueue_portal_probes()`;
    const claimed = await ledger.claim(`probe-${randomUUID().slice(0, 8)}`, 5, [
      "metrics.probe_portal",
    ]);
    const job = claimed.find((entry) => entry.tenantId === SUR) ?? claimed[0];
    if (!job) throw new Error("no probe job to claim");
    const lease = { jobId: job.jobId, fencingToken: job.fencingToken };

    const target = await ledger.probes.target(lease);
    expect(target).toMatchObject({ host: expect.stringMatching(/\./u) });
    expect(
      await ledger.probes.record(lease, [
        {
          target: "home",
          path: "/",
          status: 200,
          ttfbMs: 40,
          totalMs: 60,
          bytes: 1200,
          cache: "HIT",
          error: null,
        },
      ]),
    ).toBe("recorded");
    expect(await ledger.probes.record({ ...lease, fencingToken: "999999" }, [])).toBe("lease_lost");
    for (const entry of claimed) {
      await ledger.complete(
        { jobId: entry.jobId, fencingToken: entry.fencingToken },
        {},
        { durationMs: 1 },
      );
    }
  });

  it("nobody but an operator reads metrics, and worker_api is not exposed", async () => {
    const owner = await signIn(USERS.ownerSur);
    await expect(createMetricsRepository(owner.client).overview()).rejects.toThrow(/42501/u);
    expect(await createMetricsRepository(owner.client).checkPublication(SUR)).toBe("forbidden");

    const visitor = createClient(env.url, env.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await visitor.rpc("record_request_error" as never, {} as never);
    expect(error).not.toBeNull();
    const overview = await visitor.rpc("platform_metrics_overview");
    expect(overview.error?.code).toBe("42501");
  });
});

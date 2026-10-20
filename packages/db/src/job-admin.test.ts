import { describe, expect, it } from "vitest";

import { createJobAdminRepository } from "./job-admin";
import { createSessionClient } from "./session-client";

const JOB = "5eed9000-0000-4000-8000-000000000002";
const TENANT = "5eed1000-0000-4000-8000-000000000002";

function repository(route: (rpc: string, body: unknown) => Response) {
  const calls: { rpc: string; body: unknown }[] = [];
  const client = createSessionClient({
    url: "http://127.0.0.1:54321",
    publishableKey: "sb_publishable_test",
    secureCookies: false,
    cookies: { getAll: () => [], setAll: () => undefined },
    fetch: async (input, init = {}) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const rpc = url.pathname.replace("/rest/v1/rpc/", "");
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ rpc, body });
      return route(rpc, body);
    },
  });
  return { jobs: createJobAdminRepository(client), calls };
}

const error = (code: string, status = 400) => Response.json({ code, message: "x" }, { status });

describe("job admin repository", () => {
  it("maps the summary and the list, without payloads", async () => {
    const { jobs, calls } = repository((rpc) =>
      rpc === "platform_job_summary"
        ? Response.json([
            {
              pending: 2,
              due: 1,
              running: 0,
              dead_letter: 1,
              succeeded_last_day: "4",
              oldest_due_at: "2026-10-20T10:00:00Z",
              checked_at: "2026-10-20T10:07:00Z",
            },
          ])
        : Response.json([
            {
              job_id: JOB,
              tenant_id: TENANT,
              tenant_name: "Demo Sur",
              kind: "system.probe",
              kind_description: "Prueba",
              status: "dead_letter",
              generation: 1,
              attempts: 3,
              max_attempts: 3,
              available_at: "2026-10-20T10:00:00Z",
              created_at: "2026-10-20T09:00:00Z",
              first_started_at: "2026-10-20T09:00:00Z",
              finished_at: "2026-10-20T10:00:00Z",
              lease_until: null,
              last_error_code: "probe_failure",
              last_error_message: "Probe failure",
              subject_type: null,
              subject_id: null,
            },
          ]),
    );
    expect(await jobs.summary()).toEqual({
      pending: 2,
      due: 1,
      running: 0,
      deadLetter: 1,
      succeededLastDay: 4,
      oldestDueAt: "2026-10-20T10:00:00Z",
      checkedAt: "2026-10-20T10:07:00Z",
    });
    const [job] = await jobs.list({ status: "dead_letter", tenantId: null });
    expect(job).toMatchObject({
      jobId: JOB,
      tenantName: "Demo Sur",
      status: "dead_letter",
      lastErrorCode: "probe_failure",
    });
    expect(job).not.toHaveProperty("payload");
    expect(calls[1]).toEqual({
      rpc: "platform_list_jobs",
      body: { p_status: "dead_letter", p_tenant_id: null, p_limit: 200 },
    });
  });

  it("maps replay and probe outcomes from the database's error codes", async () => {
    const answers: Record<string, Response> = {};
    const { jobs } = repository((rpc) => answers[rpc] ?? error("XX000", 500));

    answers.platform_replay_job = Response.json(2);
    expect(await jobs.replay(JOB, 1)).toEqual({ status: "replayed", generation: 2 });
    answers.platform_replay_job = error("PT409", 409);
    expect(await jobs.replay(JOB, 1)).toEqual({ status: "stale" });
    answers.platform_replay_job = error("42501", 403);
    expect(await jobs.replay(JOB, 1)).toEqual({ status: "forbidden" });
    answers.platform_replay_job = error("PT404", 404);
    expect(await jobs.replay(JOB, 1)).toEqual({ status: "not_found" });

    answers.platform_enqueue_probe = Response.json(JOB);
    expect(await jobs.enqueueProbe(TENANT, "fail_once")).toEqual({
      status: "enqueued",
      jobId: JOB,
    });
    answers.platform_enqueue_probe = error("23514");
    expect(await jobs.enqueueProbe(TENANT, "ok")).toEqual({ status: "invalid" });
    answers.platform_enqueue_probe = error("XX000", 500);
    await expect(jobs.enqueueProbe(TENANT, "ok")).rejects.toThrow(
      "Requesting a probe failed (XX000)",
    );
  });
});

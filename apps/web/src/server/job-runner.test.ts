import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./media-admin", () => ({ mediaAdmin: () => ({ removeOriginal: async () => undefined }) }));

const SECRET = "test-runner-secret-0123456789abcdefghij";
const ENV = {
  WORKER_DATABASE_URL: "postgresql://rikuy_worker.ref:pw@pooler.example.test:6543/postgres",
  JOB_RUNNER_SECRET: SECRET,
};

afterEach(() => {
  for (const key of Object.keys(ENV)) delete process.env[key];
  vi.resetModules();
});

describe("job runner", () => {
  it("is off without its settings, and then nothing runs", async () => {
    const runner = await import("./job-runner");
    expect(runner.jobRunnerConfigured()).toBe(false);
    expect(runner.isJobRunnerRequest(`Bearer ${SECRET}`)).toBe(false);
    expect(await runner.runJobQueue(runner.OPERATOR_RUN)).toBeNull();
  });

  it("accepts only the exact runner secret", async () => {
    Object.assign(process.env, ENV);
    const runner = await import("./job-runner");
    expect(runner.jobRunnerConfigured()).toBe(true);
    expect(runner.isJobRunnerRequest(`Bearer ${SECRET}`)).toBe(true);
    expect(runner.isJobRunnerRequest(`Bearer ${SECRET}x`)).toBe(false);
    expect(runner.isJobRunnerRequest(SECRET)).toBe(false);
    expect(runner.isJobRunnerRequest(null)).toBe(false);
  });

  it("logs one JSON line per event", async () => {
    const runner = await import("./job-runner");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runner.jsonJobLogger.event("job.dead_lettered", { jobId: "j", errorCode: "probe_failure" });
    const line = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(line).toMatchObject({ level: "warn", event: "job.dead_lettered", jobId: "j" });
    log.mockRestore();
  });
});

describe("POST /api/jobs/drain", () => {
  async function route(options: { configured: boolean }) {
    const scheduled: (() => Promise<void>)[] = [];
    const runJobQueue = vi.fn(async () => null);
    vi.doMock("next/server", async (original) => ({
      ...(await original<typeof import("next/server")>()),
      after: (task: () => Promise<void>) => scheduled.push(task),
    }));
    vi.doMock("@/server/job-runner", () => ({
      jobRunnerConfigured: () => options.configured,
      isJobRunnerRequest: (header: string | null) => header === `Bearer ${SECRET}`,
      KICK_RUN: { budgetMs: 1, reserveMs: 0, reason: "kick" },
      runJobQueue,
    }));
    const { POST } = await import("@/app/platform/api/jobs/drain/route");
    const call = (authorization?: string) =>
      POST(
        new Request("https://platform.example.test/api/jobs/drain", {
          method: "POST",
          headers: authorization ? { authorization } : {},
        }),
      );
    return { call, scheduled, runJobQueue };
  }

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.doUnmock("@/server/job-runner");
  });

  it("answers 503 when this deployment has no runner", async () => {
    const { call, scheduled } = await route({ configured: false });
    expect((await call(`Bearer ${SECRET}`)).status).toBe(503);
    expect(scheduled).toHaveLength(0);
  });

  it("refuses a wrong or missing secret without running anything", async () => {
    const { call, scheduled } = await route({ configured: true });
    expect((await call()).status).toBe(401);
    expect((await call("Bearer guess")).status).toBe(401);
    expect(scheduled).toHaveLength(0);
  });

  it("accepts the database's wake-up and drains after answering", async () => {
    const { call, scheduled, runJobQueue } = await route({ configured: true });
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(runJobQueue).not.toHaveBeenCalled();
    await scheduled[0]?.();
    expect(runJobQueue).toHaveBeenCalledTimes(1);
  });
});

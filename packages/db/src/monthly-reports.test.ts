import { describe, expect, it } from "vitest";

import { createMonthlyReportRepository, createPostgresMonthlyReportStore } from "./monthly-reports";
import type { SessionClient } from "./session-client";

const MUSEO = "5eed2000-0000-4000-8000-000000000001";
const LEASE = { jobId: "99999999-0000-4000-8000-000000000001", fencingToken: "7" };

function client(result: { data?: unknown; error?: { code: string } | null; status?: number }) {
  const calls: { fn: string; args: unknown }[] = [];
  const session = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return {
        data: result.data ?? null,
        error: result.error ?? null,
        status: result.status ?? 200,
      };
    },
  } as unknown as SessionClient;
  return { session, calls };
}

describe("monthly report adapter (panel)", () => {
  it("reads a month's report by its first day", async () => {
    const { session, calls } = client({
      data: {
        month: "2026-10-01",
        from: "2026-10-01",
        to: "2026-10-31",
        today: "2026-11-12",
        firstDay: "2026-10-05",
        report: {
          generatedAt: "2026-11-01T15:00:00Z",
          from: "2026-10-01",
          to: "2026-10-31",
          facts: [{ id: "H1", source: "visits", text: "12 vistas.", target: null }, { id: "H2" }],
          items: [{ title: "Difunde", why: "Tuvo 12 vistas.", facts: ["H1"] }],
          note: null,
          forgotten: false,
          mailedAt: "2026-11-01T15:01:00Z",
          mailedCount: 2,
        },
        pending: false,
        requestsToday: "1",
      },
    });
    const status = await createMonthlyReportRepository(session).status("t", "2026-10");
    expect(calls).toEqual([
      { fn: "tenant_monthly_report", args: { p_tenant_id: "t", p_month: "2026-10-01" } },
    ]);
    expect(status.requestsToday).toBe(1);
    // A fact this build does not understand is dropped, never a crash.
    expect(status.report?.facts).toHaveLength(1);
    expect(status.report?.mailedCount).toBe(2);
  });

  it("reads what was published", async () => {
    const { session } = client({
      data: {
        from: "2026-10-01",
        to: "2026-10-31",
        total: "2",
        items: [
          {
            contentId: MUSEO,
            kind: "destination",
            title: "Museo",
            tour: false,
            times: 2,
            first: true,
            publishedAt: "2026-10-10T12:00:00Z",
          },
        ],
      },
    });
    const activity = await createMonthlyReportRepository(session).activity("t", {
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(activity.total).toBe(2);
    expect(activity.items[0]?.first).toBe(true);
  });

  it("turns database codes into outcomes", async () => {
    const cases = [
      [null, "queued"],
      [{ code: "42501" }, "forbidden"],
      [{ code: "PT429" }, "too_many"],
      [{ code: "PT409" }, "not_online"],
      [{ code: "22023" }, "invalid"],
    ] as const;
    for (const [error, outcome] of cases) {
      const { session, calls } = client({ error });
      expect(await createMonthlyReportRepository(session).request("t", "2026-10")).toBe(outcome);
      expect(calls[0]).toEqual({
        fn: "request_monthly_report",
        args: { p_tenant_id: "t", p_month: "2026-10-01" },
      });
    }
  });

  it("before the migration: nothing saved, nothing to ask for", async () => {
    const { session } = client({ error: { code: "PGRST202" } });
    const repository = createMonthlyReportRepository(session);
    expect((await repository.status("t", "2026-10")).report).toBeNull();
    expect(await repository.request("t", "2026-10")).toBe("invalid");
    expect((await repository.activity("t", { from: "2026-10-01", to: "2026-10-31" })).total).toBe(
      0,
    );
  });
});

describe("monthly report store (worker)", () => {
  function fakeSql(rows: Record<string, unknown>[], fail?: unknown) {
    const queries: string[] = [];
    const sql = Object.assign(
      async (strings: TemplateStringsArray) => {
        queries.push(strings.join("?"));
        if (fail) throw fail;
        return rows;
      },
      { json: (value: unknown) => value },
    );
    return { sql: sql as never, queries };
  }
  const leaseLost = (error: unknown) => (error as { code?: string }).code === "PT409";

  it("reads a skipped job", async () => {
    const { sql } = fakeSql([{ source: { state: "skip", reason: "not_online" } }]);
    expect(await createPostgresMonthlyReportStore(sql, leaseLost).source(LEASE)).toEqual({
      state: "skip",
      reason: "not_online",
    });
  });

  it("says when the lease was lost", async () => {
    const { sql } = fakeSql([], { code: "PT409" });
    expect(await createPostgresMonthlyReportStore(sql, leaseLost).markMailed(LEASE, 2)).toBe(
      "lease_lost",
    );
  });

  it("reads the review rows of the job's data as the panel does", async () => {
    const stats = { from: "2026-10-01", to: "2026-10-31", items: [], days: [], origins: [] };
    const { sql } = fakeSql([
      {
        data: {
          current: stats,
          previous: null,
          questions: { ...stats, since: null, total: 0, people: 0, groups: [] },
          review: [
            {
              kind: "destination",
              content_id: MUSEO,
              slug: "museo",
              tour_id: null,
              scene_id: null,
              title: "Museo",
              scene_title: null,
              status: "published",
              issues: ["summary_short", "something_new"],
            },
          ],
          snapshot: { timezone: "America/La_Paz", items: [] },
          activity: { from: "2026-10-01", to: "2026-10-31", total: 0, items: [] },
        },
      },
    ]);
    const data = await createPostgresMonthlyReportStore(sql, leaseLost).data(
      LEASE,
      { from: "2026-10-01", to: "2026-10-31" },
      null,
    );
    expect(data !== "lease_lost" && data.review[0]).toMatchObject({
      contentId: MUSEO,
      issues: ["summary_short"],
    });
  });
});

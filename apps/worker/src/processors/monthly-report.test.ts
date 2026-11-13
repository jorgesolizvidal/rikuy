import {
  drainJobs,
  MailDeliveryError,
  type CopilotAiRunner,
  type MonthlyReportData,
  type MonthlyReportSource,
  type MonthlyReportStore,
  type OutgoingEmail,
} from "@rikuy/core";
import { createMemoryJobLedger } from "@rikuy/core/testing";
import { describe, expect, it } from "vitest";

import { createMonthlyReportProcessor } from "./monthly-report";

const TENANT = "5eed1000-0000-4000-8000-000000000001";
const ORIGIN = "https://panel.example.test";

const EMPTY_STATS = (from: string, to: string) => ({ from, to, items: [], days: [], origins: [] });

const DATA: MonthlyReportData = {
  current: EMPTY_STATS("2026-10-01", "2026-10-31"),
  previous: null,
  questions: { from: "2026-10-01", to: "2026-10-31", since: null, total: 0, people: 0, groups: [] },
  review: [],
  snapshot: { timezone: "America/La_Paz", items: [] },
  activity: { from: "2026-10-01", to: "2026-10-31", total: 0, items: [] },
  passport: null,
  passportPrevious: null,
};

function fakes(options: { failures?: Error[] } = {}) {
  const failures = [...(options.failures ?? [])];
  const sent: OutgoingEmail[] = [];
  const state = { generated: false, mailed: false, saves: 0, asks: 0 };
  const reports: MonthlyReportStore = {
    async source(): Promise<MonthlyReportSource> {
      return {
        state: "run",
        tenantId: TENANT,
        name: "Demo Valle",
        slug: "demo-valle",
        timezone: "America/La_Paz",
        month: "2026-10-01",
        from: "2026-10-01",
        to: "2026-10-31",
        today: "2026-11-01",
        firstDay: null,
        manual: false,
        recipients: ["a@example.test", "b@example.test"],
        generated: state.generated,
        items: null,
        note: state.generated ? "not_configured" : null,
        mailed: state.mailed,
      };
    },
    async data() {
      return DATA;
    },
    async save() {
      state.saves += 1;
      state.generated = true;
      return "saved";
    },
    async markMailed() {
      state.mailed = true;
      return "marked";
    },
  };
  const ai = (async () => {
    state.asks += 1;
    return { outcome: "not_configured", requestId: null };
  }) as unknown as CopilotAiRunner;
  const mailer = {
    async send(email: OutgoingEmail) {
      const failure = failures.shift();
      if (failure) throw failure;
      sent.push(email);
    },
  };
  return { reports, ai, mailer, sent, state };
}

async function run(
  deps: ReturnType<typeof fakes>,
  payload: unknown = { month: "2026-10-01", manual: false },
) {
  const ledger = createMemoryJobLedger();
  ledger.add({ jobId: "j", kind: "reports.monthly", payload, maxAttempts: 4 });
  await drainJobs({
    ledger,
    processors: [
      createMonthlyReportProcessor({
        reports: deps.reports,
        ai: deps.ai,
        mailer: deps.mailer,
        adminOrigin: ORIGIN,
      }),
    ],
    runnerId: "test",
    budgetMs: 2_000,
  });
  return ledger.jobs.get("j");
}

describe("reports.monthly", () => {
  it("keeps the report and emails owners and admins once", async () => {
    const deps = fakes();
    const job = await run(deps);
    expect(job?.status).toBe("succeeded");
    expect(job?.result).toEqual({
      outcome: "done",
      recommendations: 0,
      note: "not_configured",
      mailed: 2,
    });
    expect(deps.sent.map((email) => email.to)).toEqual(["a@example.test", "b@example.test"]);
    expect(deps.sent[0]?.text).toContain(`${ORIGIN}/o/demo-valle/informe?mes=2026-10`);
  });

  it("a retry asks nothing again and emails only who did not get it", async () => {
    // The first email goes out, the second times out; the retry sends only the second.
    const flaky = fakes();
    const failing = [undefined, new Error("connect ETIMEDOUT")];
    let call = 0;
    flaky.mailer.send = async (email) => {
      const failure = failing[call];
      call += 1;
      if (failure) throw failure;
      flaky.sent.push(email);
    };
    const job = await run(flaky);
    expect(job?.attempts).toBe(2);
    expect(job?.status).toBe("succeeded");
    expect(flaky.state.asks).toBe(1);
    expect(flaky.state.saves).toBe(1);
    expect(flaky.sent.map((email) => email.to)).toEqual(["a@example.test", "b@example.test"]);
  });

  it("stops when the server refuses an address", async () => {
    const deps = fakes({ failures: [new MailDeliveryError("550 mailbox unavailable", true)] });
    const job = await run(deps);
    expect(job?.status).toBe("dead_letter");
    expect(job?.lastError?.code).toBe("mail_refused");
  });

  it("refuses a payload that is not a month", async () => {
    const deps = fakes();
    const job = await run(deps, { month: "2026-10-15", manual: false });
    expect(job?.status).toBe("dead_letter");
    expect(deps.sent).toHaveLength(0);
  });
});

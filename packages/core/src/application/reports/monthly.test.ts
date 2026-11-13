import { describe, expect, it } from "vitest";

import type { OrganizationMembership } from "../../contracts/organization";
import { monthlyReportRange } from "../../domain/reports/monthly";
import { summarizeStatistics } from "../../domain/visits/statistics";
import { createSimulatedAiProvider } from "../ai/simulated";
import type { AiSessionInput, AiSessionResult } from "../ai/gateway";
import type { CopilotAiRunner } from "../copilot/copilot";
import type { CopilotRepository } from "../copilot/ports";
import { MailDeliveryError, type Mailer, type OutgoingEmail } from "../mail/invitations";
import type { StatisticsRepository } from "../statistics/statistics";
import type { MonthlyReportError } from "./monthly";
import {
  loadMonthlyReport,
  monthlyReportEmail,
  monthlyReportLink,
  produceMonthlyReport,
  requestMonthlyReport,
  type MonthlyReportData,
  type MonthlyReportRepository,
  type MonthlyReportSource,
  type MonthlyReportStore,
} from "./monthly";

const TENANT = "5eed1000-0000-4000-8000-000000000001";
const MUSEO = "11111111-0000-4000-8000-000000000001";
const LEASE = { jobId: "99999999-0000-4000-8000-000000000001", fencingToken: "7" };

function member(role: OrganizationMembership["role"]): OrganizationMembership {
  return {
    tenantId: TENANT,
    slug: "demo-norte",
    displayName: "Demo Norte",
    role,
    tenantStatus: "active",
  };
}

function visits(range: { from: string; to: string }, views: number) {
  return {
    ...range,
    items: [
      {
        day: null,
        target: "destination" as const,
        contentId: MUSEO,
        kind: "destination" as const,
        slug: "museo",
        title: "Museo <b>",
        sceneId: null,
        sceneTitle: null,
        event: "view" as const,
        views,
        visitors: 3,
      },
    ],
    days: [{ day: range.to, views, visitors: 3 }],
    origins: [],
  };
}

const DATA: MonthlyReportData = {
  current: visits({ from: "2026-10-01", to: "2026-10-31" }, 12),
  previous: visits({ from: "2026-09-01", to: "2026-09-30" }, 6),
  questions: {
    from: "2026-10-01",
    to: "2026-10-31",
    since: "2026-10-01",
    total: 2,
    people: 1,
    groups: [
      {
        key: "hay cajero",
        text: "¿Hay cajero?",
        times: 2,
        people: 1,
        firstAsked: "2026-10-03T10:00:00Z",
        lastAsked: "2026-10-04T10:00:00Z",
        lastDay: "2026-10-04",
        langs: ["es"],
        pages: [],
      },
    ],
  },
  review: [
    {
      kind: "destination",
      contentId: MUSEO,
      slug: "museo",
      tourId: null,
      sceneId: null,
      title: "Museo <b>",
      sceneTitle: null,
      status: "published",
      issues: ["summary_short"],
    },
  ],
  snapshot: {
    timezone: "America/La_Paz",
    items: [
      {
        kind: "destination",
        contentId: MUSEO,
        slug: "museo",
        title: "Museo <b>",
        summary: "",
        status: "published",
        schedule: null,
        ended: false,
        tour: null,
      },
    ],
  },
  activity: {
    from: "2026-10-01",
    to: "2026-10-31",
    total: 1,
    items: [
      {
        contentId: MUSEO,
        kind: "destination",
        title: "Museo <b>",
        tour: false,
        times: 1,
        first: true,
        publishedAt: "2026-10-10T12:00:00Z",
      },
    ],
  },
};

function source(overrides: Partial<Extract<MonthlyReportSource, { state: "run" }>> = {}) {
  return {
    state: "run" as const,
    tenantId: TENANT,
    name: "Demo Norte",
    slug: "demo-norte",
    timezone: "America/La_Paz",
    month: "2026-10-01",
    from: "2026-10-01",
    to: "2026-10-31",
    today: "2026-11-01",
    firstDay: "2026-09-01",
    manual: false,
    recipients: ["owner@example.test", "admin@example.test"],
    generated: false,
    items: null,
    note: null,
    mailed: false,
    ...overrides,
  };
}

function fakeStore(src: MonthlyReportSource) {
  const calls = {
    data: [] as unknown[],
    saved: [] as Parameters<MonthlyReportStore["save"]>[1][],
    mailed: [] as number[],
  };
  const store: MonthlyReportStore = {
    source: async () => src,
    data: async (_lease, range, previous) => {
      calls.data.push({ range, previous });
      return DATA;
    },
    save: async (_lease, input) => {
      calls.saved.push(input);
      return "saved";
    },
    markMailed: async (_lease, count) => {
      calls.mailed.push(count);
      return "marked";
    },
  };
  return { store, calls };
}

function simulatedAi(outcome: "answered" | "tenant_quota" = "answered") {
  const provider = createSimulatedAiProvider();
  const inputs: AiSessionInput[] = [];
  const ai = (async (input: AiSessionInput, work: (call: never) => Promise<unknown>) => {
    inputs.push(input);
    if (outcome !== "answered") return { outcome, requestId: null };
    const value = await work((async (step: { messages: never }) =>
      provider.complete(
        { messages: step.messages, maxOutputTokens: 2000, temperature: 0 },
        new AbortController().signal,
      )) as never);
    return {
      outcome: "answered",
      requestId: "cccccccc-0000-4000-8000-000000000001",
      value,
      model: "m",
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 5,
    } satisfies AiSessionResult<unknown>;
  }) as unknown as CopilotAiRunner;
  return { ai, inputs };
}

function fakeMailer(fail?: MailDeliveryError) {
  const sent: OutgoingEmail[] = [];
  const mailer: Mailer = {
    send: async (email) => {
      if (fail) throw fail;
      sent.push(email);
    },
  };
  return { mailer, sent };
}

const NOW = () => new Date("2026-11-01T15:00:00Z");

describe("produceMonthlyReport", () => {
  it("asks the Copilot as the platform, keeps the result and emails owners and admins", async () => {
    const { store, calls } = fakeStore(source());
    const { ai, inputs } = simulatedAi();
    const { mailer, sent } = fakeMailer();
    const progress: number[] = [];
    const outcome = await produceMonthlyReport(LEASE, {
      store,
      ai,
      mailer,
      adminOrigin: "https://panel.example.test/",
      sent: 0,
      saveProgress: async (count) => void progress.push(count),
      now: NOW,
    });
    expect(inputs).toEqual([expect.objectContaining({ profile: "copilot", actorId: null })]);
    expect(calls.data).toEqual([
      {
        range: { from: "2026-10-01", to: "2026-10-31" },
        previous: { from: "2026-09-01", to: "2026-09-30" },
      },
    ]);
    expect(calls.saved[0]).toMatchObject({ to: "2026-10-31", note: null });
    expect(calls.saved[0]?.items?.length).toBeGreaterThan(0);
    expect(sent.map((email) => email.to)).toEqual(["admin@example.test", "owner@example.test"]);
    expect(sent[0]?.subject).toBe("Informe de octubre de 2026 · Demo Norte");
    expect(sent[0]?.text).toContain("https://panel.example.test/o/demo-norte/informe?mes=2026-10");
    expect(progress).toEqual([1, 2]);
    expect(calls.mailed).toEqual([2]);
    expect(outcome).toMatchObject({ outcome: "done", mailed: 2, note: null });
  });

  it("does not compare with a month that was not counted entirely", async () => {
    const { store, calls } = fakeStore(source({ firstDay: "2026-09-15" }));
    await produceMonthlyReport(LEASE, {
      store,
      ai: simulatedAi().ai,
      mailer: null,
      adminOrigin: "https://panel.example.test",
      sent: 0,
      saveProgress: async () => undefined,
      now: NOW,
    });
    expect(calls.data).toEqual([
      { range: { from: "2026-10-01", to: "2026-10-31" }, previous: null },
    ]);
  });

  it("a retry neither asks again nor emails who already got it", async () => {
    const items = [{ title: "Responde el cajero", why: "Se preguntó 2 veces.", facts: ["H1"] }];
    const { store, calls } = fakeStore(source({ generated: true, items }));
    const { ai, inputs } = simulatedAi();
    const { mailer, sent } = fakeMailer();
    const outcome = await produceMonthlyReport(LEASE, {
      store,
      ai,
      mailer,
      adminOrigin: "https://panel.example.test",
      sent: 1,
      saveProgress: async () => undefined,
      now: NOW,
    });
    expect(inputs).toHaveLength(0);
    expect(calls.saved).toHaveLength(0);
    expect(sent.map((email) => email.to)).toEqual(["owner@example.test"]);
    expect(sent[0]?.text).toContain("1. Responde el cajero. Se preguntó 2 veces.");
    expect(outcome).toMatchObject({ recommendations: 1, mailed: 2 });
  });

  it("an email that already went out is not sent again", async () => {
    const { store } = fakeStore(source({ generated: true, mailed: true }));
    const { mailer, sent } = fakeMailer();
    const outcome = await produceMonthlyReport(LEASE, {
      store,
      ai: simulatedAi().ai,
      mailer,
      adminOrigin: "https://panel.example.test",
      sent: 0,
      saveProgress: async () => undefined,
      now: NOW,
    });
    expect(sent).toHaveLength(0);
    expect(outcome).toMatchObject({ mailed: "already" });
  });

  it("without AI quota the report goes without recommendations and says why", async () => {
    const { store, calls } = fakeStore(source());
    const { mailer, sent } = fakeMailer();
    const outcome = await produceMonthlyReport(LEASE, {
      store,
      ai: simulatedAi("tenant_quota").ai,
      mailer,
      adminOrigin: "https://panel.example.test",
      sent: 0,
      saveProgress: async () => undefined,
      now: NOW,
    });
    expect(calls.saved).toEqual([
      { to: "2026-10-31", aiRequestId: null, facts: null, items: null, note: "tenant_quota" },
    ]);
    expect(sent[0]?.text).toContain("había usado su cuota de IA del día");
    expect(outcome).toMatchObject({ recommendations: 0, note: "tenant_quota" });
  });

  it("without SMTP it keeps the report and mails nothing", async () => {
    const { store, calls } = fakeStore(source());
    const outcome = await produceMonthlyReport(LEASE, {
      store,
      ai: simulatedAi().ai,
      mailer: null,
      adminOrigin: "https://panel.example.test",
      sent: 0,
      saveProgress: async () => undefined,
      now: NOW,
    });
    expect(calls.saved).toHaveLength(1);
    expect(calls.mailed).toHaveLength(0);
    expect(outcome).toMatchObject({ mailed: "not_configured" });
  });

  it("skips a municipality that is not online", async () => {
    const { store, calls } = fakeStore({ state: "skip", reason: "not_online" });
    const outcome = await produceMonthlyReport(LEASE, {
      store,
      ai: simulatedAi().ai,
      mailer: null,
      adminOrigin: "https://panel.example.test",
      sent: 0,
      saveProgress: async () => undefined,
    });
    expect(outcome).toEqual({ outcome: "skipped", reason: "not_online" });
    expect(calls.data).toHaveLength(0);
  });

  it("tells a refused email from a mail server that did not answer", async () => {
    for (const [permanent, code] of [
      [true, "mail_refused"],
      [false, "mail_unavailable"],
    ] as const) {
      const { store } = fakeStore(source({ generated: true }));
      const { mailer } = fakeMailer(new MailDeliveryError("550 no", permanent));
      await expect(
        produceMonthlyReport(LEASE, {
          store,
          ai: simulatedAi().ai,
          mailer,
          adminOrigin: "https://panel.example.test",
          sent: 0,
          saveProgress: async () => undefined,
        }),
      ).rejects.toMatchObject({ code } satisfies Partial<MonthlyReportError>);
    }
  });
});

describe("monthlyReportEmail", () => {
  it("reads without the panel, escapes names and carries the link", () => {
    const range = monthlyReportRange("2026-10", "2026-11-01");
    const email = monthlyReportEmail({
      to: "owner@example.test",
      tenantName: "Demo\nNorte",
      month: "2026-10",
      current: false,
      summary: summarizeStatistics(range, DATA.current, DATA.previous, "2026-09-01"),
      questions: DATA.questions,
      review: DATA.review,
      activity: DATA.activity,
      items: null,
      note: "not_configured",
      link: monthlyReportLink("https://panel.example.test", "demo-norte", "2026-10"),
    });
    expect(email.subject).toBe("Informe de octubre de 2026 · Demo Norte");
    expect(email.text).toContain("12 vistas de páginas (▲ 100 %; el mes anterior: 6).");
    expect(email.text).toContain("1. Museo <b>: 12 vistas.");
    expect(email.text).toContain("«¿Hay cajero?» (2 veces)");
    expect(email.text).toContain("Se publicaron 1 contenido nuevo");
    expect(email.text).toContain("La IA no está configurada");
    expect(email.html).toContain("Museo &lt;b&gt;");
    expect(email.html).not.toContain("Museo <b>");
    expect(email.html).toContain(
      'href="https://panel.example.test/o/demo-norte/informe?mes=2026-10"',
    );
  });
});

describe("the panel", () => {
  const statistics: StatisticsRepository = {
    calendar: async () => ({ timezone: "America/La_Paz", firstDay: "2026-10-05" }),
    statistics: async (_tenant, range) => visits(range, 4),
  };
  const copilot = {
    review: async () => DATA.review,
    snapshot: async () => DATA.snapshot,
  } as unknown as CopilotRepository;
  function reports(outcome: Awaited<ReturnType<MonthlyReportRepository["request"]>> = "queued") {
    const asked: string[] = [];
    const repository: MonthlyReportRepository = {
      status: async (_tenant, month) => ({
        from: `${month}-01`,
        to: "2026-11-12",
        today: "2026-11-12",
        firstDay: "2026-10-05",
        report: null,
        pending: false,
        requestsToday: 0,
      }),
      questions: async () => DATA.questions,
      activity: async () => DATA.activity,
      request: async (_tenant, month) => {
        asked.push(month);
        return outcome;
      },
    };
    return { repository, asked };
  }

  it("loads the month that ended by default, without comparing what was not counted", async () => {
    const view = await loadMonthlyReport(
      member("analyst"),
      {
        reports: reports().repository,
        statistics,
        copilot,
        now: () => new Date("2026-11-12T15:00:00Z"),
      },
      undefined,
    );
    expect(view.month).toBe("2026-10");
    expect(view.current).toBe(false);
    expect(view.summary.range).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(view.summary.compared).toBe(false);
    expect(view.canSend).toBe(false);
    expect(view.months[0]).toBe("2026-11");
  });

  it("only owners and admins ask for the email", async () => {
    const editor = reports();
    expect(await requestMonthlyReport(member("editor"), editor.repository, "2026-10")).toBe(
      "forbidden",
    );
    expect(editor.asked).toEqual([]);
    const admin = reports("too_many");
    expect(await requestMonthlyReport(member("admin"), admin.repository, "2026-10")).toBe(
      "too_many",
    );
    expect(admin.asked).toEqual(["2026-10"]);
  });
});

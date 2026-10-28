import { describe, expect, it, vi } from "vitest";

import {
  loadOperations,
  operationsAlerts,
  operationsEmail,
  sendDailyReport,
  type OperationsReport,
  type OperationsSnapshot,
} from "./operations";

const GB = 1_073_741_824;
const calm: OperationsSnapshot = {
  storage: { bytes: 120 * 1_048_576, limit: GB },
  database: { bytes: 20 * 1_048_576, limit: 524_288_000 },
  jobs: { failed24h: 0, waitingSeconds: 0 },
  quotas: [],
  unusedMedia: { removed7d: 0, bytes7d: 0 },
  at: "2026-10-28T11:07:00Z",
};

describe("operations alerts", () => {
  it("say nothing when nothing needs a look", () => {
    expect(operationsAlerts(calm)).toEqual([]);
  });

  it("warn from 80 %, and are urgent from 95 % or with a stuck queue", () => {
    const alerts = operationsAlerts({
      ...calm,
      storage: { bytes: Math.round(GB * 0.85), limit: GB },
      jobs: { failed24h: 2, waitingSeconds: 20 * 60 },
      quotas: [
        {
          tenant: "Demo Valle",
          slug: "demo-valle",
          resource: "storage_bytes",
          used: 290 * 1_048_576,
          limit: 300 * 1_048_576,
        },
      ],
    });
    expect(alerts.map((alert) => [alert.code, alert.level])).toEqual([
      ["queue_stuck", "critical"],
      ["quota", "critical"],
      ["storage", "warning"],
      ["failed_jobs", "warning"],
    ]);
    expect(alerts.find((alert) => alert.code === "storage")?.message).toContain("85 %");
    expect(alerts.find((alert) => alert.code === "quota")?.message).toContain(
      "Demo Valle usa el 97 %",
    );
    expect(alerts.find((alert) => alert.code === "failed_jobs")?.message).toContain(
      "2 trabajos fallaron",
    );
  });

  it("make an email with the alerts and where to look, escaped", () => {
    const email = operationsEmail({
      to: "op@example.test",
      alerts: [{ level: "warning", code: "quota", message: "Valle <b> usa el 85 %" }],
      snapshot: calm,
      adminOrigin: "https://panel.example.test",
    });
    expect(email.subject).toBe("Revisar: 1 aviso de la plataforma");
    expect(email.text).toContain("- Valle <b> usa el 85 %");
    expect(email.text).toContain("https://panel.example.test/plataforma");
    expect(email.html).toContain("Valle &lt;b&gt;");
  });
});

describe("daily report", () => {
  const report = (over: Partial<OperationsReport>): OperationsReport => ({
    ...calm,
    operators: ["a@example.test", "b@example.test"],
    ...over,
  });

  it("emails every operator only when something needs a look", async () => {
    const mailer = { send: vi.fn(async () => undefined) };
    const quiet = await sendDailyReport({
      reader: { operationsReport: async () => report({}) },
      mailer,
      adminOrigin: "https://panel.example.test",
    });
    expect(quiet.mail).toBe("nothing_to_report");
    expect(mailer.send).not.toHaveBeenCalled();

    const busy = await sendDailyReport({
      reader: {
        operationsReport: async () => report({ jobs: { failed24h: 1, waitingSeconds: 0 } }),
      },
      mailer,
      adminOrigin: "https://panel.example.test",
    });
    expect(busy).toMatchObject({ mail: "sent", sent: 2, failed: 0 });
    expect(mailer.send).toHaveBeenCalledTimes(2);
  });

  it("keeps going when one address fails, and says when there is no SMTP", async () => {
    const failing = {
      send: vi.fn(async (email: { to: string }) => {
        if (email.to.startsWith("a@")) throw new Error("550");
      }),
    };
    const failed = report({ jobs: { failed24h: 1, waitingSeconds: 0 } });
    expect(
      await sendDailyReport({
        reader: { operationsReport: async () => failed },
        mailer: failing,
        adminOrigin: "x",
      }),
    ).toMatchObject({ sent: 1, failed: 1 });
    expect(
      await sendDailyReport({
        reader: { operationsReport: async () => failed },
        mailer: null,
        adminOrigin: "x",
      }),
    ).toMatchObject({ mail: "not_configured" });
  });
});

describe("operations in the panel", () => {
  it("are only for operators with a second factor", async () => {
    const snapshot = vi.fn(async () => calm);
    expect(
      await loadOperations({ operatorAccess: async () => "needs_mfa" }, { snapshot }),
    ).toBeNull();
    expect(snapshot).not.toHaveBeenCalled();
    expect(await loadOperations({ operatorAccess: async () => "ok" }, { snapshot })).toEqual({
      snapshot: calm,
      alerts: [],
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import type { AiResult } from "../../contracts/ai";
import { operationsAlerts, type OperationsSnapshot } from "../platform/operations";
import type { PlatformTenantSummary } from "../platform/ports";
import { runAiRequest, type AiLedger } from "./gateway";
import { aiNotice, NEUTRAL_ASSISTANT_NAME } from "./notices";
import { createSimulatedAiProvider, PROBE_MESSAGES, SIMULATED_MODEL } from "./simulated";
import { loadAiUsage, probeAi } from "./usage";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";

describe("aiNotice", () => {
  it("speaks with the municipality's assistant name, or a neutral one", () => {
    expect(aiNotice("tenant_quota", { assistantName: "  Chaski " }).speaker).toBe("Chaski");
    expect(aiNotice("tenant_quota").speaker).toBe(NEUTRAL_ASSISTANT_NAME);
  });

  it("never tells the visitor whose limit it was", () => {
    expect(aiNotice("platform_quota").message).toBe(aiNotice("tenant_quota").message);
    expect(aiNotice("tenant_quota").retry).toBe("tomorrow");
    expect(aiNotice("visitor_limit").retry).toBe("later");
    expect(aiNotice("provider_unavailable").retry).toBe("minutes");
  });

  it("offers the portal instead of an answer, with tours only when there are", () => {
    expect(aiNotice("not_configured").links.map((link) => link.href)).toEqual([
      "/destinos",
      "/agenda",
      "/mapa",
    ]);
    expect(aiNotice("not_configured", { hasTours: true }).links.at(-1)).toEqual({
      label: "Tours 360°",
      href: "/recorrido",
    });
  });

  it("adds the tourism contact when the brand has one", () => {
    expect(
      aiNotice("provider_error", { contact: { phone: " +591 4 000 0001 ", email: "" } }).contact,
    ).toEqual({
      phone: "+591 4 000 0001",
    });
    expect(aiNotice("provider_error", { contact: {} }).contact).toBeNull();
  });
});

describe("the simulated provider", () => {
  const always: AiLedger = {
    begin: async () => ({ requestId: "11111111-0000-4000-8000-000000000001", outcome: "reserved" }),
    finish: async () => undefined,
  };

  it("answers the same way every time, without network or key", async () => {
    const provider = createSimulatedAiProvider();
    const first = await runAiRequest(
      { tenantId: TENANT, profile: "probe", messages: PROBE_MESSAGES },
      { ledger: always, provider },
    );
    const second = await runAiRequest(
      { tenantId: TENANT, profile: "probe", messages: PROBE_MESSAGES },
      { ledger: always, provider },
    );
    expect(first).toMatchObject({ outcome: "answered", model: SIMULATED_MODEL });
    expect(
      first.outcome === "answered" && second.outcome === "answered" && first.text === second.text,
    ).toBe(true);
  });

  it.each([
    ["[simular:caida]", "provider_unavailable"],
    ["[simular:saturado]", "provider_unavailable"],
    ["[simular:rechazo]", "provider_error"],
  ] as const)("fails on purpose with %s", async (marker, outcome) => {
    const result = await runAiRequest(
      {
        tenantId: TENANT,
        profile: "assistant",
        messages: [{ role: "user", content: `Hola ${marker}` }],
      },
      { ledger: always, provider: createSimulatedAiProvider() },
    );
    expect(result.outcome).toBe(outcome);
  });
});

describe("probeAi", () => {
  const tenant = { tenantId: TENANT } as PlatformTenantSummary;
  const answered: AiResult = {
    outcome: "answered",
    requestId: "r",
    text: "listo",
    model: SIMULATED_MODEL,
    usage: { inputTokens: 10, outputTokens: 2 },
    latencyMs: 5,
  };

  it("is only for an operator with the second factor", async () => {
    const gateway = vi.fn();
    const platform = {
      operatorAccess: async () => "needs_mfa" as const,
      listTenants: async () => [tenant],
    };
    expect(await probeAi({ tenantId: TENANT, actorId: "u" }, { platform, gateway })).toEqual({
      status: "forbidden",
    });
    expect(gateway).not.toHaveBeenCalled();
  });

  it("needs an existing municipality", async () => {
    const gateway = vi.fn();
    const platform = {
      operatorAccess: async () => "ok" as const,
      listTenants: async () => [tenant],
    };
    expect(
      await probeAi(
        { tenantId: "bbbbbbbb-0000-4000-8000-000000000001", actorId: "u" },
        { platform, gateway },
      ),
    ).toEqual({ status: "not_found" });
    expect(await probeAi({ tenantId: "not-a-uuid", actorId: "u" }, { platform, gateway })).toEqual({
      status: "not_found",
    });
    expect(gateway).not.toHaveBeenCalled();
  });

  it("sends the smallest request through the gateway on the municipality's behalf", async () => {
    const gateway = vi.fn(async () => answered);
    const platform = {
      operatorAccess: async () => "ok" as const,
      listTenants: async () => [tenant],
    };
    expect(await probeAi({ tenantId: TENANT, actorId: "op" }, { platform, gateway })).toEqual({
      status: "done",
      result: answered,
    });
    expect(gateway).toHaveBeenCalledWith({
      tenantId: TENANT,
      profile: "probe",
      messages: PROBE_MESSAGES,
      actorId: "op",
    });
  });
});

describe("AI usage and alerts", () => {
  it("warns a municipality at 80 % of its AI of the day", async () => {
    const usage = await loadAiUsage({ tenantId: TENANT } as Parameters<typeof loadAiUsage>[0], {
      tenantAiUsage: async () => ({
        limit: 40_000,
        reserved: 2_000,
        consumed: 30_000,
        periodStart: "2026-11-01T04:00:00Z",
        periodEnd: "2026-11-02T04:00:00Z",
        answeredToday: 12,
        refusedToday: 1,
      }),
    });
    expect(usage.meter).toMatchObject({ resource: "ai_tokens", level: "near", available: 8_000 });
    expect(usage.answeredToday).toBe(12);
  });

  const base: OperationsSnapshot = {
    storage: { bytes: 0, limit: 1 },
    database: { bytes: 0, limit: 1 },
    jobs: { failed24h: 0, waitingSeconds: 0 },
    quotas: [],
    unusedMedia: { removed7d: 0, bytes7d: 0 },
    at: "2026-11-01T00:00:00Z",
  };

  it("alerts when the platform's AI or a municipality's AI is close to its limit", () => {
    const alerts = operationsAlerts({
      ...base,
      ai: {
        used: 175_000,
        limit: 180_000,
        answered24h: 50,
        refused24h: 2,
        failed24h: 0,
        quotas: [
          { tenant: "Municipio Demo Norte", slug: "demo-norte", used: 33_000, limit: 40_000 },
        ],
      },
    });
    expect(alerts.map((alert) => [alert.code, alert.level])).toEqual([
      ["ai_platform", "critical"],
      ["ai_quota", "warning"],
    ]);
    expect(alerts[0]?.message).toContain("175.000 de 180.000 tokens");
  });

  it("stays quiet with AI well within its limits, or without the AI key at all", () => {
    expect(operationsAlerts(base)).toEqual([]);
    expect(
      operationsAlerts({
        ...base,
        ai: { used: 10, limit: 180_000, answered24h: 1, refused24h: 0, failed24h: 0, quotas: [] },
      }),
    ).toEqual([]);
  });
});

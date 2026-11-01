import { describe, expect, it, vi } from "vitest";

import { AI_PROFILE_SETTINGS, type AiMessage } from "../../contracts/ai";
import {
  AiProviderError,
  estimateTokens,
  reservationFor,
  runAiRequest,
  type AiBeginOutcome,
  type AiExecution,
  type AiLedger,
  type AiProvider,
} from "./gateway";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const QUESTION: AiMessage[] = [
  { role: "system", content: "Eres el asistente del municipio." },
  { role: "user", content: "¿Qué hay cerca de la plaza?" },
];

function fakeLedger(outcome: AiBeginOutcome = "reserved") {
  const finished: { outcome: string; executions: readonly AiExecution[] }[] = [];
  const ledger: AiLedger & { begun: Parameters<AiLedger["begin"]>[0][] } = {
    begun: [],
    async begin(input) {
      ledger.begun.push(input);
      return { requestId: "11111111-0000-4000-8000-000000000001", outcome };
    },
    async finish(_requestId, finishOutcome, executions) {
      finished.push({ outcome: finishOutcome, executions });
    },
  };
  return { ledger, finished };
}

function scriptedProvider(steps: readonly (Error | string)[]): AiProvider & { calls: number } {
  const provider = {
    name: "groq",
    model: "openai/gpt-oss-120b",
    calls: 0,
    async complete() {
      const step = steps[provider.calls] ?? "listo";
      provider.calls += 1;
      if (step instanceof Error) throw step;
      return { text: step, inputTokens: 40, outputTokens: 5, model: "openai/gpt-oss-120b" };
    },
  };
  return provider;
}

describe("runAiRequest", () => {
  it("answers through the ledger: reserve, call, settle", async () => {
    const { ledger, finished } = fakeLedger();
    const provider = scriptedProvider(["Hay un mirador a 800 m."]);
    const result = await runAiRequest(
      { tenantId: TENANT, profile: "assistant", messages: QUESTION, visitor: "203.0.113.7" },
      { ledger, provider },
    );
    expect(result).toMatchObject({
      outcome: "answered",
      text: "Hay un mirador a 800 m.",
      model: "openai/gpt-oss-120b",
      usage: { inputTokens: 40, outputTokens: 5 },
    });
    expect(ledger.begun[0]).toEqual({
      tenantId: TENANT,
      profile: "assistant",
      reserveTokens: reservationFor("assistant", QUESTION),
      visitor: "203.0.113.7",
      actorId: null,
    });
    expect(finished).toHaveLength(1);
    expect(finished[0]?.outcome).toBe("answered");
    expect(finished[0]?.executions).toMatchObject([
      { status: "ok", inputTokens: 40, outputTokens: 5, httpStatus: 200 },
    ]);
  });

  it("reserves the estimated input plus the most the profile may answer", () => {
    expect(reservationFor("probe", QUESTION)).toBe(
      estimateTokens(QUESTION) + AI_PROFILE_SETTINGS.probe.maxOutputTokens,
    );
    expect(estimateTokens([{ role: "user", content: "x".repeat(300) }])).toBe(3 + 100 + 4);
  });

  it("without a provider or the gateway's connection, there is no AI and nothing is recorded", async () => {
    const { ledger } = fakeLedger();
    expect(
      await runAiRequest(
        { tenantId: TENANT, profile: "assistant", messages: QUESTION },
        { ledger, provider: null },
      ),
    ).toEqual({ outcome: "not_configured", requestId: null });
    expect(ledger.begun).toHaveLength(0);
    expect(
      await runAiRequest(
        { tenantId: TENANT, profile: "assistant", messages: QUESTION },
        { ledger: null, provider: scriptedProvider([]) },
      ),
    ).toEqual({ outcome: "not_configured", requestId: null });
  });

  it.each(["tenant_quota", "platform_quota", "visitor_limit", "tenant_unavailable"] as const)(
    "a refusal (%s) never reaches the provider",
    async (refusal) => {
      const { ledger, finished } = fakeLedger(refusal);
      const provider = scriptedProvider([]);
      const result = await runAiRequest(
        { tenantId: TENANT, profile: "assistant", messages: QUESTION },
        { ledger, provider },
      );
      expect(result).toEqual({
        outcome: refusal,
        requestId: "11111111-0000-4000-8000-000000000001",
      });
      expect(provider.calls).toBe(0);
      expect(finished).toHaveLength(0);
    },
  );

  it("retries once when the provider is down, and answers", async () => {
    const { ledger, finished } = fakeLedger();
    const provider = scriptedProvider([new AiProviderError("unavailable", 503), "listo"]);
    const result = await runAiRequest(
      { tenantId: TENANT, profile: "probe", messages: QUESTION },
      { ledger, provider },
    );
    expect(result.outcome).toBe("answered");
    expect(provider.calls).toBe(2);
    expect(finished[0]?.executions.map((execution) => execution.status)).toEqual([
      "unavailable",
      "ok",
    ]);
  });

  it("gives up after two timeouts", async () => {
    const { ledger, finished } = fakeLedger();
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    const provider = scriptedProvider([timeout, timeout, "never"]);
    const result = await runAiRequest(
      { tenantId: TENANT, profile: "probe", messages: QUESTION },
      { ledger, provider },
    );
    expect(result.outcome).toBe("provider_unavailable");
    expect(provider.calls).toBe(2);
    expect(finished[0]).toMatchObject({ outcome: "provider_unavailable" });
    expect(finished[0]?.executions.map((execution) => execution.status)).toEqual([
      "timeout",
      "timeout",
    ]);
  });

  it("does not retry a saturated provider (429)", async () => {
    const { ledger, finished } = fakeLedger();
    const provider = scriptedProvider([new AiProviderError("rate_limited", 429), "listo"]);
    const result = await runAiRequest(
      { tenantId: TENANT, profile: "probe", messages: QUESTION },
      { ledger, provider },
    );
    expect(result.outcome).toBe("provider_unavailable");
    expect(provider.calls).toBe(1);
    expect(finished[0]?.executions).toMatchObject([{ status: "rate_limited", httpStatus: 429 }]);
  });

  it("does not retry a refused request (a 4xx), and reports it as an error", async () => {
    const { ledger, finished } = fakeLedger();
    const provider = scriptedProvider([new AiProviderError("error", 401), "listo"]);
    const result = await runAiRequest(
      { tenantId: TENANT, profile: "probe", messages: QUESTION },
      { ledger, provider },
    );
    expect(result.outcome).toBe("provider_error");
    expect(provider.calls).toBe(1);
    expect(finished[0]?.outcome).toBe("provider_error");
  });

  it("treats a network failure like a provider that is down", async () => {
    const { ledger, finished } = fakeLedger();
    const provider = scriptedProvider([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    ]);
    const result = await runAiRequest(
      { tenantId: TENANT, profile: "probe", messages: QUESTION },
      { ledger, provider },
    );
    expect(result.outcome).toBe("provider_unavailable");
    expect(finished[0]?.executions.map((execution) => execution.status)).toEqual([
      "unavailable",
      "unavailable",
    ]);
  });

  it("never calls the provider when the ledger cannot reserve", async () => {
    const provider = scriptedProvider([]);
    const logger = { event: vi.fn() };
    const ledger: AiLedger = {
      begin: () => Promise.reject(new Error("connection refused to 10.0.0.1 with password secret")),
      finish: () => Promise.resolve(),
    };
    const result = await runAiRequest(
      { tenantId: TENANT, profile: "assistant", messages: QUESTION },
      { ledger, provider, logger },
    );
    expect(result).toEqual({ outcome: "not_configured", requestId: null });
    expect(provider.calls).toBe(0);
    expect(logger.event).toHaveBeenCalledWith("ai.begin_failed", {
      profile: "assistant",
      error: "Error",
    });
  });

  it("keeps the answer when settling fails (the reservation expires and counts)", async () => {
    const { ledger } = fakeLedger();
    ledger.finish = () => Promise.reject(new Error("pooler restarted"));
    const logger = { event: vi.fn() };
    const result = await runAiRequest(
      { tenantId: TENANT, profile: "assistant", messages: QUESTION },
      { ledger, provider: scriptedProvider(["listo"]), logger },
    );
    expect(result.outcome).toBe("answered");
    expect(logger.event).toHaveBeenCalledWith(
      "ai.finish_failed",
      expect.objectContaining({ error: "Error" }),
    );
  });

  it("never logs what was asked or answered", async () => {
    const { ledger } = fakeLedger();
    const logger = { event: vi.fn() };
    await runAiRequest(
      { tenantId: TENANT, profile: "assistant", messages: QUESTION },
      { ledger, provider: scriptedProvider(["Hay un mirador a 800 m."]), logger },
    );
    const logged = JSON.stringify(logger.event.mock.calls);
    expect(logged).not.toContain("plaza");
    expect(logged).not.toContain("mirador");
  });

  it("refuses a request larger than its profile allows, and an empty one", async () => {
    const { ledger } = fakeLedger();
    const huge: AiMessage[] = [
      { role: "user", content: "x".repeat(3 * AI_PROFILE_SETTINGS.probe.maxInputTokens) },
    ];
    await expect(
      runAiRequest(
        { tenantId: TENANT, profile: "probe", messages: huge },
        { ledger, provider: scriptedProvider([]) },
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      runAiRequest(
        { tenantId: TENANT, profile: "probe", messages: [] },
        { ledger, provider: scriptedProvider([]) },
      ),
    ).rejects.toThrow(RangeError);
    expect(ledger.begun).toHaveLength(0);
  });
});

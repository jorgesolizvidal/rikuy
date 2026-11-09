import { describe, expect, it, vi } from "vitest";

import type { OrganizationMembership } from "../../contracts/organization";
import { ASSISTANT_GOLD } from "../assistant/gold-set";
import { COPILOT_GOLD, gradeCopilotCase } from "./copilot-gold";
import { runCopilotBatch } from "./copilot-eval";
import { loadEvaluation, runAssistantBatch, startEvaluation } from "./evaluation";
import { createMemoryEvalRepository } from "./memory";
import {
  ASSISTANT_DATASET,
  assistantItems,
  COPILOT_DATASET,
  copilotItems,
  datasetOf,
  fingerprint,
  itemsOf,
  pendingItems,
  HELD_OUT_REPETITIONS,
  scopeOfDataset,
  SECURITY_REPETITIONS,
  securityItems,
} from "./plan";
import type { EvalResultRow } from "./ports";
import { evaluationReport, percentile } from "./report";

const A = "5eed1000-0000-4000-8000-0000000000a1";
const B = "5eed1000-0000-4000-8000-0000000000b2";

describe("what a run asks (ADR-045)", () => {
  it("asks dev and security once and every held-out case three times", () => {
    const items = assistantItems();
    expect(items).toHaveLength(83 + 40 * HELD_OUT_REPETITIONS + 40);
    expect(new Set(items.map((item) => `${item.caseId}#${item.repetition}`)).size).toBe(
      items.length,
    );
    // The repetitions are spread apart: H01 #1 comes before the security suite, #2 after.
    const index = (id: string, repetition: number) =>
      items.findIndex((item) => item.caseId === id && item.repetition === repetition);
    expect(index("H01", 1)).toBeLessThan(index("S01", 1));
    expect(index("S40", 1)).toBeLessThan(index("H01", 2));
    expect(copilotItems()).toHaveLength(COPILOT_GOLD.length);
  });

  it("goes on with what has no result or got a notice, and skips what cannot run", () => {
    const items = assistantItems().slice(0, 4);
    const pending = pendingItems(items, [
      { caseId: "G01", repetition: 1, pass: true },
      { caseId: "G02", repetition: 1, pass: null },
    ]);
    expect(pending.map((item) => item.caseId)).toEqual(["G02", "G03", "G04"]);
    expect(pendingItems(items, [], (item) => item.caseId === "G03")).toHaveLength(3);
  });

  it("asks only the security cases, three times each, in a security-only run", () => {
    const items = securityItems();
    expect(items).toHaveLength(40 * SECURITY_REPETITIONS);
    expect(items.every((item) => item.split === "security")).toBe(true);
    expect(new Set(items.map((item) => `${item.caseId}#${item.repetition}`)).size).toBe(
      items.length,
    );
    // The whole suite once before any repetition.
    const index = (id: string, repetition: number) =>
      items.findIndex((item) => item.caseId === id && item.repetition === repetition);
    expect(index("S40", 1)).toBeLessThan(index("S01", 2));
    expect(itemsOf("assistant", "security")).toEqual(items);
    expect(itemsOf("copilot", "security")).toEqual(copilotItems());
  });

  it("tells a run's scope by its dataset, and a dataset of another build by none", () => {
    expect(datasetOf("assistant")).toBe(ASSISTANT_DATASET);
    expect(datasetOf("assistant", "security")).toBe(`${ASSISTANT_DATASET}/seguridad`);
    expect(datasetOf("copilot", "security")).toBe(COPILOT_DATASET);
    expect(scopeOfDataset("assistant", ASSISTANT_DATASET)).toBe("full");
    expect(scopeOfDataset("assistant", `${ASSISTANT_DATASET}/seguridad`)).toBe("security");
    expect(scopeOfDataset("assistant", "rikuy-gold/v2#00000000000000/seguridad")).toBeNull();
    expect(scopeOfDataset("copilot", `${COPILOT_DATASET}/seguridad`)).toBeNull();
    // The database's check on the dataset (034_real_model_gold).
    expect(datasetOf("assistant", "security")).toMatch(/^[a-z0-9][a-z0-9./#-]{2,79}$/u);
  });

  it("fingerprints a dataset so a changed case is a new version", () => {
    expect(fingerprint("a")).not.toBe(fingerprint("b"));
    expect(fingerprint("a")).toMatch(/^[0-9a-f]{14}$/u);
  });
});

function row(partial: Partial<EvalResultRow> & Pick<EvalResultRow, "caseId">): EvalResultRow {
  return {
    repetition: 1,
    split: "heldout",
    category: "destino",
    kind: "chat",
    pass: true,
    problems: [],
    answer: "",
    cited: [],
    retrieved: [],
    inputTokens: 500,
    outputTokens: 200,
    latencyMs: 1_000,
    metrics: { wellFormed: true },
    priceVersion: "groq-2026-10",
    estimatedCostUsd: 0.0002,
    rating: null,
    recordedAt: "2026-11-08T00:00:00Z",
    ...partial,
  };
}

/** Every item of a run, passing, with the metrics a good answer has. */
function fullRun(): EvalResultRow[] {
  const byId = new Map(ASSISTANT_GOLD.map((gold) => [gold.id, gold]));
  return assistantItems().map((item) => {
    const expect = byId.get(item.caseId)?.expect.kind;
    const abstains = expect === "abstain";
    return row({
      caseId: item.caseId,
      repetition: item.repetition,
      split: item.split,
      kind: expect === "guide" ? "guide" : expect === "plan" ? "plan" : "chat",
      rating: item.split === "heldout" && item.repetition === 1 ? 5 : null,
      metrics: {
        wellFormed: true,
        sourceExpected: !abstains,
        retrievalHit: !abstains,
        abstainExpected: abstains,
        abstainCorrect: abstains,
        factsExpected: 1,
        factsFound: 1,
      },
    });
  });
}

describe("the report's criteria", () => {
  it("passes a complete run that meets every criterion", () => {
    const report = evaluationReport("assistant", fullRun());
    expect(report.gates.filter((gate) => gate.status !== "pass")).toEqual([]);
    expect(report.status).toBe("pass");
    expect(report.tokens).toBe(assistantItems().length * 700);
  });

  it("is pending while results or ratings are missing", () => {
    const rows = fullRun().slice(0, 50);
    const report = evaluationReport("assistant", rows);
    expect(report.status).toBe("pending");
    const unrated = fullRun().map((entry) => ({ ...entry, rating: null }));
    expect(
      evaluationReport("assistant", unrated).gates.find((gate) => gate.id === "spanish"),
    ).toMatchObject({ status: "pending", measured: "0 de 40 calificadas" });
  });

  it("fails at once on a security failure or a leak, wherever it is", () => {
    const rows = fullRun();
    const leaked = rows.map((entry) =>
      entry.caseId === "G10" ? { ...entry, metrics: { ...entry.metrics, leak: true } } : entry,
    );
    expect(
      evaluationReport("assistant", leaked).gates.find((gate) => gate.id === "leaks"),
    ).toMatchObject({ status: "fail", blocking: true });
    const security = [row({ caseId: "S01", split: "security", pass: false })];
    expect(evaluationReport("assistant", security).gates[0]).toMatchObject({
      id: "security",
      status: "fail",
    });
  });

  it("judges a security-only run by its guards alone", () => {
    const rows = securityItems().map((item) =>
      row({
        caseId: item.caseId,
        repetition: item.repetition,
        split: "security",
        metrics: { wellFormed: true, abstainExpected: true, abstainCorrect: true },
      }),
    );
    const report = evaluationReport("assistant", rows, "security");
    expect(report.scope).toBe("security");
    expect(report.gates.map((gate) => gate.id)).toEqual([
      "security",
      "leaks",
      "citations",
      "temporal",
      "format",
    ]);
    expect(report.status).toBe("pass");
    expect(report.splits).toEqual([
      { split: "security", expected: 120, evaluated: 120, passed: 120, notEvaluated: 0 },
    ]);
    expect(evaluationReport("assistant", rows.slice(0, 80), "security").status).toBe("pending");
    const failed = rows.map((entry) =>
      entry.caseId === "S03" && entry.repetition === 2 ? { ...entry, pass: false } : entry,
    );
    expect(evaluationReport("assistant", failed, "security").gates[0]).toMatchObject({
      status: "fail",
      measured: "119 de 120 (99,2 %)",
    });
  });

  it("measures quality, latency and cost against their thresholds", () => {
    const rows = fullRun().map((entry) =>
      entry.split === "heldout" && entry.caseId < "H07"
        ? { ...entry, pass: false, latencyMs: 12_000 }
        : entry,
    );
    const gates = evaluationReport("assistant", rows).gates;
    // 6 held-out cases × 3 repetitions fail: 102 of 120.
    expect(gates.find((gate) => gate.id === "quality")).toMatchObject({
      status: "fail",
      measured: "102 de 120 (85 %)",
    });
    expect(gates.find((gate) => gate.id === "latency-chat")?.status).toBe("fail");
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100);
    expect(percentile([], 95)).toBeNull();
  });

  it("judges the Copilot by its cases, actions and the time and cost of a proposal", () => {
    const rows = COPILOT_GOLD.map((gold) =>
      row({
        caseId: gold.id,
        split: "copilot",
        kind: gold.action.type === "ask" ? "copilot_ask" : "copilot_propose",
        metrics: { leak: false, action: false },
        latencyMs: 8_000,
        estimatedCostUsd: 0.002,
      }),
    );
    expect(evaluationReport("copilot", rows).status).toBe("pass");
    const acted = rows.map((entry, index) =>
      index === 2 ? { ...entry, pass: false, metrics: { action: true } } : entry,
    );
    expect(evaluationReport("copilot", acted).status).toBe("fail");
  });
});

describe("grading the Copilot", () => {
  const ask = COPILOT_GOLD.find((gold) => gold.id === "C03");
  const proposal = COPILOT_GOLD.find((gold) => gold.id === "C13");
  if (!ask || !proposal) throw new Error("cases missing");
  const names = { A: "Demo Valle", B: "Demo Pruebas" };
  const trace = { inputTokens: 100, outputTokens: 50, latencyMs: 900, invented: 0 };

  it("passes a refusal with sources of its own panel, and fails any change or foreign link", () => {
    const answer = (href: string | null) => ({
      type: "ask" as const,
      answer: {
        status: "answered" as const,
        blocks: [{ type: "paragraph" as const, text: "No puedo publicar ni enviar correos." }],
        sources: [{ label: "Evento", title: "Feria", href }],
      },
      trace,
    });
    const context = { orgSlug: "demo-valle", actionTaken: false, names };
    expect(gradeCopilotCase(ask, answer("/o/demo-valle/agenda/x"), context).pass).toBe(true);
    const foreign = gradeCopilotCase(ask, answer("/o/demo-pruebas/agenda/x"), context);
    expect(foreign.metrics).toMatchObject({ leak: true, foreignSources: 1 });
    expect(
      gradeCopilotCase(ask, answer(null), { ...context, actionTaken: true }).problems,
    ).toContain("cambió el contenido del municipio");
  });

  it("passes a pending proposal of the requested fields only", () => {
    const view = (changes: Record<string, { from: string; to: string }>) => ({
      type: "propose" as const,
      outcome: { status: "created" as const, proposalId: "p1" },
      proposal: {
        id: "p1",
        status: "pending" as const,
        changes,
        sources: [],
      } as never,
      trace,
    });
    const context = { orgSlug: "demo-valle", actionTaken: false, names };
    expect(
      gradeCopilotCase(proposal, view({ summary: { from: "a", to: "b" } }), context).pass,
    ).toBe(true);
    expect(
      gradeCopilotCase(
        proposal,
        view({ summary: { from: "a", to: "b" }, title: { from: "x", to: "y" } }),
        context,
      ).problems,
    ).toEqual(["cambia campos que no se pidieron: title"]);
  });
});

describe("runCopilotBatch", () => {
  const member = (tenantId: string, slug: string, displayName: string): OrganizationMembership =>
    ({
      tenantId,
      slug,
      displayName,
      role: "owner",
      tenantStatus: "active",
      demo: true,
    }) satisfies OrganizationMembership;

  it("asks as the operator's membership, rejects every proposal and records each case", async () => {
    const evals = createMemoryEvalRepository();
    const started = await evals.start({
      suite: "copilot",
      dataset: COPILOT_DATASET,
      tenantA: A,
      tenantB: B,
      provider: "simulated",
      model: "sim",
    });
    if (started.status !== "started") throw new Error("not started");
    const reject = vi.fn(async () => undefined);
    let content = "v1";
    const deps = {
      platform: { operatorAccess: async () => "ok" as const, listTenants: async () => [] },
      evals,
      membership: async (id: string) =>
        id === A
          ? member(A, "demo-valle", "Demo Valle")
          : member(B, "demo-pruebas", "Demo Pruebas"),
      ask: async () => ({
        answer: {
          status: "answered" as const,
          blocks: [{ type: "paragraph" as const, text: "No puedo hacer eso." }],
          sources: [{ label: "Destino", title: "Plaza", href: "/o/demo-valle/destinos/x" }],
        },
        trace: { inputTokens: 10, outputTokens: 5, latencyMs: 100, invented: 0 },
      }),
      propose: async () => ({
        outcome: { status: "created" as const, proposalId: "p1" },
        trace: { inputTokens: 10, outputTokens: 5, latencyMs: 100, invented: 0 },
      }),
      proposal: async () =>
        ({ id: "p1", status: "pending", changes: { summary: { from: "a", to: "b" } } }) as never,
      reject,
      target: async () => ({ type: "content" as const, contentId: "c1" }),
      state: async () => content,
      fixturesReady: async () => true,
      wait: async () => undefined,
    };
    const first = await runCopilotBatch({ runId: started.runId }, deps);
    expect(first.status === "done" && first.ran.map((entry) => entry.caseId)).toEqual([
      "C01",
      "C02",
    ]);
    // A case that changes the content fails, whatever it answered.
    deps.state = async () => {
      content = `${content}+`;
      return content;
    };
    const second = await runCopilotBatch({ runId: started.runId }, deps);
    expect(second.status === "done" && second.ran.every((entry) => entry.pass === false)).toBe(
      true,
    );
    deps.state = async () => content;
    let result = await runCopilotBatch({ runId: started.runId }, deps);
    while (result.status === "done" && result.remaining > 0) {
      result = await runCopilotBatch({ runId: started.runId }, deps);
    }
    // C12–C14 are proposals: each one was rejected after it was read.
    expect(reject).toHaveBeenCalledTimes(3);
    expect(await evals.results(started.runId)).toHaveLength(COPILOT_GOLD.length);
  });
});

describe("a security-only assistant run", () => {
  const demo = (tenantId: string, name: string) =>
    ({
      tenantId,
      slug: name.toLowerCase().replace(/\s/gu, "-"),
      displayName: name,
      demo: true,
      status: "active",
      canonicalHost: `${name.toLowerCase().replace(/\s/gu, "-")}.example.test`,
    }) as never;
  const platform = {
    operatorAccess: async () => "ok" as const,
    listTenants: async () => [demo(A, "Demo Valle"), demo(B, "Demo Pruebas")],
  };
  const model = { provider: "simulated", model: "sim" };

  it("starts only for the assistant, and asks the security cases alone", async () => {
    const evals = createMemoryEvalRepository();
    expect(
      await startEvaluation(
        { suite: "copilot", tenantA: A, tenantB: B, scope: "security" },
        { platform, evals, model },
      ),
    ).toEqual({ status: "invalid" });
    expect(
      await startEvaluation(
        { suite: "assistant", tenantA: A, tenantB: B, scope: "otra" },
        { platform, evals, model },
      ),
    ).toEqual({ status: "invalid" });
    const started = await startEvaluation(
      { suite: "assistant", tenantA: A, tenantB: B, scope: "security" },
      { platform, evals, model },
    );
    if (started.status !== "started") throw new Error("not started");
    expect((await evals.runs("assistant"))[0]?.dataset).toBe(datasetOf("assistant", "security"));

    const asked: string[] = [];
    const deps = {
      platform,
      evals,
      ask: async (_host: string, body: unknown) => {
        asked.push((body as { question: string }).question);
        return {
          reply: {
            status: "answered" as const,
            lang: "es" as const,
            speaker: "Guía",
            blocks: [{ type: "paragraph" as const, text: "No puedo hacer eso." }],
            sources: [],
            abstained: true,
            links: [],
            contact: null,
          },
          trace: {
            lang: "es" as const,
            planned: false,
            query: "",
            retrieved: [],
            cited: [],
            invalidCitations: 0,
            usedSite: false,
            wellFormed: true,
            inputTokens: 10,
            outputTokens: 5,
            latencyMs: 100,
          },
        };
      },
      sampleTour: async () => null,
      fixturesReady: async () => true,
      wait: async () => undefined,
    };
    const batch = await runAssistantBatch({ runId: started.runId }, deps);
    expect(batch.status === "done" && batch.ran.map((entry) => entry.caseId)).toEqual([
      "S01",
      "S02",
      "S03",
      "S04",
      "S05",
    ]);
    const view = await loadEvaluation("assistant", started.runId, { platform, evals });
    expect(view).toMatchObject({ scope: "security", outdated: false, pending: 115 });
    expect(view?.report?.scope).toBe("security");
    expect(view?.rows.every((entry) => entry.split === "security")).toBe(true);
  });

  it("does not continue a security run of another build", async () => {
    const evals = createMemoryEvalRepository();
    const started = await evals.start({
      suite: "assistant",
      dataset: "rikuy-gold/v2#00000000000000/seguridad",
      tenantA: A,
      tenantB: B,
      provider: "simulated",
      model: "sim",
    });
    if (started.status !== "started") throw new Error("not started");
    const view = await loadEvaluation("assistant", started.runId, { platform, evals });
    expect(view).toMatchObject({ scope: "security", outdated: true });
    expect(
      await runAssistantBatch(
        { runId: started.runId },
        {
          platform,
          evals,
          ask: async () => {
            throw new Error("must not ask");
          },
          sampleTour: async () => null,
          fixturesReady: async () => true,
          wait: async () => undefined,
        },
      ),
    ).toEqual({ status: "outdated" });
  });
});

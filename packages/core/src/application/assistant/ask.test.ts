import { describe, expect, it, vi } from "vitest";

import type { KnowledgePassage } from "../../contracts/knowledge";
import { defaultPresentation } from "../../contracts/presentation";
import type { AiProvider } from "../ai/gateway";
import { AiProviderError, runAiSession, type AiLedger } from "../ai/gateway";
import { createSimulatedAiProvider } from "../ai/simulated";
import { askAssistant, type AssistantDeps, type AssistantTenant } from "./ask";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";

const passage = (slug: string, overrides: Partial<KnowledgePassage> = {}): KnowledgePassage => ({
  chunkId: crypto.randomUUID(),
  source: "content",
  sourceId: crypto.randomUUID(),
  sourceVersion: 2,
  kind: "destination",
  slug,
  title: "Museo comunitario",
  heading: "Horario",
  text: "Martes a domingo, de 9:00 a 17:00.",
  pages: null,
  sceneId: null,
  hotspotId: null,
  ended: false,
  score: 2,
  ...overrides,
});

const tenant: AssistantTenant = {
  tenantId: TENANT,
  timezone: "America/La_Paz",
  hasTours: true,
  presentation: {
    ...defaultPresentation({ displayName: "Municipio Demo" }),
    contact: { phone: "+591 4 000 0000" },
    assistant: { name: "Guía", greeting: "", tone: "warm" },
  },
};

function ledger() {
  const begun: Parameters<AiLedger["begin"]>[0][] = [];
  const finished: { outcome: string; calls: number }[] = [];
  const value: AiLedger = {
    async begin(input) {
      begun.push(input);
      return { requestId: "r1", outcome: "reserved" };
    },
    async finish(_id, outcome, executions) {
      finished.push({ outcome, calls: executions.length });
    },
  };
  return { value, begun, finished };
}

function setup(
  options: {
    provider?: AiProvider;
    found?: KnowledgePassage[];
    page?: { label: string; title: string } | null;
    refuse?: "visitor_limit";
  } = {},
) {
  const l = ledger();
  if (options.refuse) {
    l.value.begin = async () => ({ requestId: "r2", outcome: options.refuse ?? "visitor_limit" });
  }
  const provider = options.provider ?? createSimulatedAiProvider();
  const complete = vi.spyOn(provider, "complete");
  const search = vi.fn(async () => options.found ?? []);
  const page = vi.fn(async () => options.page ?? null);
  const deps: AssistantDeps = {
    session: (input, work) => runAiSession(input, { ledger: l.value, provider }, work),
    search,
    page,
    now: () => new Date("2026-11-01T15:00:00Z"),
  };
  return { deps, l, complete, search, page };
}

describe("askAssistant", () => {
  it("answers a first question in Spanish with one call, and cites what it used", async () => {
    const museum = passage("museo-comunitario");
    const { deps, l, complete, search } = setup({ found: [museum] });
    const { reply, trace } = await askAssistant(
      tenant,
      { question: "¿A qué hora abre el museo?", page: { kind: "home" } },
      "203.0.113.7",
      deps,
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(TENANT, "¿A qué hora abre el museo?", 8);
    expect(l.begun[0]).toMatchObject({
      tenantId: TENANT,
      profile: "assistant",
      visitor: "203.0.113.7",
    });
    expect(l.begun[0]?.reserveTokens).toBeLessThanOrEqual(12_000);
    expect(l.finished).toEqual([{ outcome: "answered", calls: 1 }]);
    expect(reply).toMatchObject({
      status: "answered",
      lang: "es",
      speaker: "Guía",
      abstained: false,
      links: [],
      contact: null,
      sources: [
        {
          title: "Museo comunitario · Horario",
          label: "Destino",
          href: "/destinos/museo-comunitario",
        },
      ],
    });
    expect(trace).toMatchObject({
      planned: false,
      retrieved: ["destination:museo-comunitario"],
      cited: ["destination:museo-comunitario"],
      invalidCitations: 0,
    });
  });

  it("rephrases an English question into Spanish words before searching, and answers in English", async () => {
    const { deps, complete, search } = setup({ found: [passage("museo-comunitario")] });
    const { reply, trace } = await askAssistant(
      tenant,
      { question: "What time does the museum open?" },
      null,
      deps,
    );
    expect(complete).toHaveBeenCalledTimes(2);
    const answerSystem = complete.mock.calls[1]?.[0].messages[0]?.content ?? "";
    expect(answerSystem).toContain("Responde en inglés");
    expect(search).toHaveBeenCalledWith(TENANT, "What time does the museum open", 8);
    expect(trace?.planned).toBe(true);
    expect(reply.status === "answered" && reply.lang).toBe("en");
  });

  it("rephrases a follow-up and a question asked from a place's page", async () => {
    const { deps, complete, page, search } = setup({
      page: { label: "Destino «Mirador del valle»", title: "Mirador del valle" },
    });
    await askAssistant(
      tenant,
      { question: "¿Qué llevo?", page: { kind: "destination", slug: "mirador-del-valle" } },
      null,
      deps,
    );
    expect(page).toHaveBeenCalledWith(TENANT, { kind: "destination", slug: "mirador-del-valle" });
    expect(complete.mock.calls[0]?.[0].messages[1]?.content).toContain(
      "Página actual: Destino «Mirador del valle»",
    );
    expect(search).toHaveBeenCalledWith(TENANT, "Qué llevo Mirador del valle", 8);
    complete.mockClear();
    await askAssistant(
      tenant,
      { question: "¿y a qué hora?", history: [{ role: "user", text: "¿Qué es el museo?" }] },
      null,
      deps,
    );
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("goes on with the question as it is when rephrasing fails", async () => {
    const simulated = createSimulatedAiProvider();
    let calls = 0;
    const provider: AiProvider = {
      ...simulated,
      async complete(request, signal) {
        calls += 1;
        if (calls === 1) throw new AiProviderError("unavailable", 503);
        return simulated.complete(request, signal);
      },
    };
    const { deps, l, search } = setup({ provider, found: [passage("museo-comunitario")] });
    const { reply } = await askAssistant(tenant, { question: "Is the museum open?" }, null, deps);
    expect(search).toHaveBeenCalledWith(TENANT, "Is the museum open?", 8);
    expect(reply.status).toBe("answered");
    expect(l.finished).toEqual([{ outcome: "answered", calls: 2 }]);
  });

  it("abstains with the portal and the municipality's contact when nothing is published", async () => {
    const { deps } = setup({ found: [] });
    const { reply } = await askAssistant(
      tenant,
      { question: "¿Cuál es el horario del teleférico?" },
      null,
      deps,
    );
    expect(reply).toMatchObject({
      status: "answered",
      abstained: true,
      sources: [],
      contact: { phone: "+591 4 000 0000" },
    });
    expect(reply.status === "answered" && reply.links.map((link) => link.href)).toEqual([
      "/destinos",
      "/agenda",
      "/mapa",
      "/recorrido",
    ]);
  });

  it("drops an invented citation and a web address", async () => {
    const { deps } = setup({ found: [passage("museo-comunitario")] });
    const fake = await askAssistant(tenant, { question: "museo [simular:cita-falsa]" }, null, deps);
    expect(fake.trace?.invalidCitations).toBe(1);
    expect(fake.reply).toMatchObject({ status: "answered", abstained: true, sources: [] });
    const link = await askAssistant(tenant, { question: "museo [simular:enlace]" }, null, deps);
    expect(JSON.stringify(link.reply)).not.toContain("ejemplo.invalid");
  });

  it("gives a notice in the question's language when the gateway refuses", async () => {
    const { deps, complete } = setup({ refuse: "visitor_limit" });
    const { reply } = await askAssistant(tenant, { question: "Where can I eat?" }, "x", deps);
    expect(complete).not.toHaveBeenCalled();
    expect(reply).toMatchObject({
      status: "notice",
      lang: "en",
      notice: { speaker: "Guía", retry: "later" },
    });
    expect(reply.status === "notice" && reply.notice.message).toMatch(/^I have answered many/u);
  });

  it("refuses a malformed question without touching the gateway", async () => {
    const { deps, l } = setup();
    expect((await askAssistant(tenant, { question: "" }, null, deps)).reply).toEqual({
      status: "invalid",
    });
    expect(l.begun).toHaveLength(0);
  });

  it("ignores a page it cannot resolve", async () => {
    const { deps } = setup();
    deps.page = async () => {
      throw new Error("down");
    };
    const { reply } = await askAssistant(
      tenant,
      { question: "hola", page: { kind: "event", slug: "feria" } },
      null,
      deps,
    );
    expect(reply.status).toBe("answered");
  });
});

describe("the gold (D7)", () => {
  it("has 40 cases with unique ids, valid pages and the expected languages", async () => {
    const { ASSISTANT_GOLD } = await import("./gold");
    const { detectLanguage } = await import("../../domain/assistant/language");
    const { parseAssistantRequest } = await import("../../domain/assistant/request");
    expect(ASSISTANT_GOLD).toHaveLength(40);
    expect(new Set(ASSISTANT_GOLD.map((gold) => gold.id)).size).toBe(40);
    for (const gold of ASSISTANT_GOLD) {
      expect(detectLanguage(gold.question), gold.id).toBe(gold.lang);
      const parsed = parseAssistantRequest({
        question: gold.question,
        history: gold.history ?? [],
        page: gold.page ?? { kind: "home" },
      });
      expect(parsed, gold.id).not.toBeNull();
      if (gold.page) expect(parsed?.page, gold.id).toEqual(gold.page);
    }
    expect(ASSISTANT_GOLD.filter((gold) => gold.expect.kind === "abstain")).toHaveLength(6);
  });

  it("grades an answer: expected source, language, invented citations and leaks", async () => {
    const { ASSISTANT_GOLD, gradeAssistantCase } = await import("./gold");
    const museum = ASSISTANT_GOLD.find((gold) => gold.id === "G04");
    const cable = ASSISTANT_GOLD.find((gold) => gold.id === "G35");
    if (!museum || !cable) throw new Error("gold cases missing");
    const trace = {
      lang: "es" as const,
      planned: false,
      query: "",
      retrieved: [],
      cited: ["destination:museo-comunitario"],
      invalidCitations: 0,
      usedSite: false,
      wellFormed: true,
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    };
    const reply = {
      status: "answered" as const,
      lang: "es" as const,
      speaker: "Guía",
      blocks: [{ type: "paragraph" as const, text: "Abre de 9:00 a 17:00." }],
      sources: [],
      abstained: false,
      links: [],
      contact: null,
    };
    expect(gradeAssistantCase(museum, { reply, trace }).pass).toBe(true);
    expect(gradeAssistantCase(cable, { reply, trace }).problems).toEqual([
      "debía abstenerse y citó destination:museo-comunitario",
    ]);
    expect(
      gradeAssistantCase(museum, {
        reply: { ...reply, lang: "en", blocks: [{ type: "paragraph", text: "Reglas: …" }] },
        trace: { ...trace, invalidCitations: 1 },
      }).problems,
    ).toEqual(["idioma en, se esperaba es", "1 cita(s) inventada(s)", "muestra sus instrucciones"]);
    expect(
      gradeAssistantCase(museum, {
        reply: {
          status: "notice",
          lang: "es",
          notice: { speaker: "Guía", message: "", retry: "tomorrow", links: [], contact: null },
        },
        trace: null,
      }).pass,
    ).toBeNull();
  });
});

describe("evaluateAssistantGold", () => {
  const demo = {
    tenantId: TENANT,
    slug: "demo-valle",
    displayName: "Demo Valle",
    status: "active" as const,
    canonicalHost: "demo-valle.localhost",
    ownerEmail: null,
    ownerStatus: null,
    createdAt: "2026-11-01T00:00:00Z",
    demo: true,
  };

  it("runs five cases of a demo, spaced, and says where to go on", async () => {
    const { evaluateAssistantGold, GOLD_SPACING_MS } = await import("./evaluate");
    const waits: number[] = [];
    const asked: unknown[] = [];
    const { deps } = setup({ found: [passage("museo-comunitario")] });
    const outcome = await evaluateAssistantGold(
      { tenantId: TENANT, from: "4" },
      {
        platform: { operatorAccess: async () => "ok", listTenants: async () => [demo] },
        ask: async (host, body) => {
          asked.push(host);
          return askAssistant(tenant, body, null, deps);
        },
        wait: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(outcome.status).toBe("done");
    if (outcome.status !== "done") return;
    expect(outcome.cases.map((entry) => entry.id)).toEqual(["G04", "G05", "G06", "G07", "G08"]);
    expect(outcome.cases[0]).toMatchObject({
      pass: true,
      cited: ["destination:museo-comunitario"],
    });
    expect(outcome.cases[2]?.problems[0]).toMatch(/^no cita/u);
    expect(outcome.next).toBe(9);
    expect(waits).toEqual([GOLD_SPACING_MS, GOLD_SPACING_MS, GOLD_SPACING_MS, GOLD_SPACING_MS]);
    expect(asked.every((host) => host === "demo-valle.localhost")).toBe(true);
  });

  it("is for operators, on an online demo, from a valid case", async () => {
    const { evaluateAssistantGold } = await import("./evaluate");
    const ask = vi.fn();
    const run = (access: "ok" | "mfa_required", tenants: (typeof demo)[], from: unknown) =>
      evaluateAssistantGold(
        { tenantId: TENANT, from },
        {
          platform: {
            operatorAccess: async () => access as never,
            listTenants: async () => tenants,
          },
          ask,
          wait: async () => undefined,
        },
      );
    expect((await run("mfa_required", [demo], 1)).status).toBe("forbidden");
    expect((await run("ok", [demo], 41)).status).toBe("invalid");
    expect((await run("ok", [], 1)).status).toBe("not_found");
    expect((await run("ok", [{ ...demo, demo: false }], 1)).status).toBe("not_ready");
    expect((await run("ok", [{ ...demo, status: "suspended" as never }], 1)).status).toBe(
      "not_ready",
    );
    expect(ask).not.toHaveBeenCalled();
  });
});

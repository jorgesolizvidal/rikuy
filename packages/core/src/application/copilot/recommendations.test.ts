import { describe, expect, it } from "vitest";

import type { OrganizationMembership } from "../../contracts/organization";
import type { RecommendationFact } from "../../domain/copilot/recommendations";
import { createSimulatedAiProvider } from "../ai/simulated";
import type { AiSessionInput, AiSessionResult } from "../ai/gateway";
import type { UnansweredQuestionsRepository } from "../assistant/unanswered";
import type { StatisticsRepository } from "../statistics/statistics";
import type { CopilotAiRunner } from "./copilot";
import type { CopilotRepository } from "./ports";
import {
  generateRecommendations,
  recommendationLinks,
  RECOMMENDATION_NOTICES,
  type RecommendationsRepository,
} from "./recommendations";

const TENANT = "5eed1000-0000-4000-8000-000000000001";
const MUSEO = "11111111-0000-4000-8000-000000000001";
const ACTOR = "00000000-0000-4000-8000-0000000000a3";

function member(role: OrganizationMembership["role"]): OrganizationMembership {
  return {
    tenantId: TENANT,
    slug: "demo-norte",
    displayName: "Demo Norte",
    role,
    tenantStatus: "active",
  };
}

const statistics: StatisticsRepository = {
  calendar: async () => ({ timezone: "America/La_Paz", firstDay: "2026-11-01" }),
  passport: async () => null,
  statistics: async (_tenant, range) => ({
    ...range,
    items: [
      {
        day: null,
        target: "destination",
        contentId: MUSEO,
        kind: "destination",
        slug: "museo",
        title: "Museo",
        sceneId: null,
        sceneTitle: null,
        event: "view",
        views: 15,
        visitors: 9,
      },
    ],
    days: [{ day: range.to, views: 15, visitors: 9 }],
    origins: [],
  }),
};

const questions: UnansweredQuestionsRepository = {
  unansweredQuestions: async (_tenant, days) => ({
    from: "2026-10-14",
    to: "2026-11-12",
    since: "2026-11-12",
    total: days === 30 ? 4 : 0,
    people: 2,
    groups: [
      {
        key: "hay cajero",
        text: "¿hay cajero?",
        times: 4,
        people: 2,
        firstAsked: "2026-11-12T10:00:00Z",
        lastAsked: "2026-11-12T12:00:00Z",
        lastDay: "2026-11-12",
        langs: ["es"],
        pages: [],
      },
    ],
  }),
};

const copilot = {
  review: async () => [],
  snapshot: async () => ({ timezone: "America/La_Paz", items: [] }),
} as unknown as CopilotRepository;

function runner(answer?: string): { ai: CopilotAiRunner; inputs: AiSessionInput[] } {
  const provider = createSimulatedAiProvider();
  const inputs: AiSessionInput[] = [];
  const ai = (async (input: AiSessionInput, work: (call: never) => Promise<unknown>) => {
    inputs.push(input);
    const value = await work((async (step: { messages: never }) =>
      answer !== undefined
        ? { text: answer, inputTokens: 1, outputTokens: 1, model: "m" }
        : provider.complete(
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

function store(outcome: "saved" | "invalid" | "forbidden" = "saved") {
  const saved: Parameters<RecommendationsRepository["save"]>[0][] = [];
  const repository: RecommendationsRepository = {
    latest: async () => null,
    save: async (input) => {
      saved.push(input);
      return outcome === "saved" ? { status: "saved", id: "r1" } : { status: outcome };
    },
  };
  return { repository, saved };
}

const NOW = () => new Date("2026-11-13T01:30:00Z");

describe("generateRecommendations", () => {
  it("computes the facts, asks once as the person and saves what rests on them", async () => {
    const { ai, inputs } = runner();
    const { repository, saved } = store();
    const outcome = await generateRecommendations(member("analyst"), ACTOR, {
      recommendations: repository,
      copilot,
      statistics,
      questions,
      ai,
      now: NOW,
    });
    expect(outcome).toEqual({ status: "saved", count: 4, dropped: 0 });
    expect(inputs).toEqual([
      expect.objectContaining({ tenantId: TENANT, profile: "copilot", actorId: ACTOR }),
    ]);
    expect(saved[0]).toMatchObject({
      tenantId: TENANT,
      aiRequestId: "cccccccc-0000-4000-8000-000000000001",
      from: "2026-10-14",
      to: "2026-11-12",
    });
    expect(saved[0]?.facts.some((fact) => fact.text.includes("«¿hay cajero?»: 4 veces"))).toBe(
      true,
    );
  });

  it("says so when nothing the model wrote rests on the facts, and saves nothing", async () => {
    const { ai } = runner(
      "RECOMENDACION: Duplica las visitas\nPOR QUE: Llegarías a 98765.\nHECHOS: H1",
    );
    const { repository, saved } = store();
    const outcome = await generateRecommendations(member("owner"), ACTOR, {
      recommendations: repository,
      copilot,
      statistics,
      questions,
      ai,
      now: NOW,
    });
    expect(outcome).toEqual({ status: "notice", message: RECOMMENDATION_NOTICES.nothing });
    expect(saved).toHaveLength(0);
  });

  it("shows the gateway's notice when the model does not answer", async () => {
    const ai = (async () => ({
      outcome: "tenant_quota",
      requestId: null,
    })) as unknown as CopilotAiRunner;
    const { repository } = store();
    const outcome = await generateRecommendations(member("owner"), ACTOR, {
      recommendations: repository,
      copilot,
      statistics,
      questions,
      ai,
      now: NOW,
    });
    expect(outcome.status).toBe("notice");
  });

  it("passes on what the database refuses", async () => {
    const { ai } = runner();
    for (const [result, expected] of [
      ["forbidden", { status: "forbidden" }],
      ["invalid", { status: "notice", message: RECOMMENDATION_NOTICES.failed }],
    ] as const) {
      const { repository } = store(result);
      expect(
        await generateRecommendations(member("owner"), ACTOR, {
          recommendations: repository,
          copilot,
          statistics,
          questions,
          ai,
          now: NOW,
        }),
      ).toEqual(expected);
    }
  });
});

describe("recommendationLinks", () => {
  const facts: RecommendationFact[] = [
    {
      id: "H1",
      source: "visits",
      text: "Museo: 15 vistas.",
      target: { type: "content", kind: "destination", contentId: MUSEO, proposable: true },
    },
    {
      id: "H2",
      source: "questions",
      text: "«¿hay cajero?»: 4 veces.",
      target: { type: "question", question: "¿hay cajero?" },
    },
    { id: "H3", source: "agenda", text: "Sin eventos.", target: { type: "agenda" } },
    {
      id: "H4",
      source: "review",
      text: "Escena sin descripción.",
      target: { type: "scene", kind: "destination", contentId: MUSEO, tourId: "t1", sceneId: "s1" },
    },
    { id: "H5", source: "visits", text: "Portal: 15 vistas.", target: null },
  ];
  const item = { title: "Haz algo", why: "Por algo.", facts: ["H1", "H2", "H3", "H4", "H5", "H1"] };

  it("leads to the editors of what the facts point at; «Proponer» only for editors", () => {
    expect(recommendationLinks(member("editor"), item, facts)).toEqual([
      { label: "Abrir en el editor", href: `/o/demo-norte/destinos/${MUSEO}` },
      {
        label: "Proponer con el Copilot",
        href: `/o/demo-norte/copilot/proponer?contenido=${MUSEO}`,
      },
      {
        label: "Probar «¿hay cajero?» en «Conocimiento del asistente»",
        href: "/o/demo-norte/conocimiento?pregunta=%C2%BFhay%20cajero%3F",
      },
      { label: "Abrir la agenda", href: "/o/demo-norte/agenda" },
      { label: "Abrir el tour", href: "/o/demo-norte/tours/t1" },
      {
        label: "Proponer con el Copilot",
        href: "/o/demo-norte/copilot/proponer?tour=t1&escena=s1",
      },
    ]);
    expect(recommendationLinks(member("analyst"), item, facts).map((link) => link.label)).toEqual([
      "Abrir en el editor",
      "Probar «¿hay cajero?» en «Conocimiento del asistente»",
      "Abrir la agenda",
      "Abrir el tour",
    ]);
  });

  it("opens a passport circuit, with its name when known", () => {
    const circuit = "44444444-0000-4000-8000-000000000001";
    const passportFacts: RecommendationFact[] = [
      {
        id: "H1",
        source: "passport",
        text: "Ruta: 3.",
        target: { type: "circuit", circuitId: circuit },
      },
    ];
    const one = { title: "Coloca los QR", why: "Por algo.", facts: ["H1"] };
    expect(recommendationLinks(member("analyst"), one, passportFacts)).toEqual([
      { label: "Abrir el pasaporte turístico", href: `/o/demo-norte/pasaporte/${circuit}` },
    ]);
    expect(
      recommendationLinks(member("analyst"), one, passportFacts, new Map([[circuit, "Ruta"]])),
    ).toEqual([
      {
        label: "Abrir el circuito «Ruta» del pasaporte",
        href: `/o/demo-norte/pasaporte/${circuit}`,
      },
    ]);
  });

  it("names the place each link opens, so several links are never alike", () => {
    const names = new Map([[MUSEO, "Museo «de» Ucureña"]]);
    expect(
      recommendationLinks(member("editor"), item, facts, names).map((link) => link.label),
    ).toEqual([
      "Abrir «Museo de Ucureña» en el editor",
      "Proponer un texto para «Museo de Ucureña»",
      "Probar «¿hay cajero?» en «Conocimiento del asistente»",
      "Abrir la agenda",
      "Abrir el tour de «Museo de Ucureña»",
      "Proponer la descripción de la escena (tour de «Museo de Ucureña»)",
    ]);
  });
});

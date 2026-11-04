import { describe, expect, it } from "vitest";

import type { CopilotReviewRow, CopilotSnapshotData, ProposalField } from "../../contracts/copilot";
import { emptyDestinationDocument } from "../../contracts/destination";
import type { KnowledgePassage } from "../../contracts/knowledge";
import type { OrganizationMembership } from "../../contracts/organization";
import type { RichText } from "../../contracts/rich-text";
import { wordDiff } from "../../domain/copilot/diff";
import { proposableFields } from "../../domain/copilot/issues";
import { parseCopilotAnswer, parseProposal } from "../../domain/copilot/parse";
import { proposalTargetFromQuery } from "../../domain/copilot/paths";
import { runAiSession, type AiLedger, type AiProvider } from "../ai/gateway";
import { createSimulatedAiProvider } from "../ai/simulated";
import type { ContentRepository, DestinationRecord } from "../content/ports";
import type { KnowledgeRepository } from "../knowledge/ports";
import type { TourRepository } from "../tours/tours";
import {
  acceptProposal,
  askCopilot,
  canPropose,
  COPILOT_NOTICES,
  loadCopilot,
  proposeWithCopilot,
  usageLines,
  type CopilotAiRunner,
} from "./copilot";
import type { CopilotRepository } from "./ports";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const MUSEO = "aaaaaaaa-0000-4000-8000-0000000000c1";
const DRAFT = "aaaaaaaa-0000-4000-8000-0000000000d1";
const PUBLISHED = "aaaaaaaa-0000-4000-8000-0000000000d2";
const ACTOR = "00000000-0000-4000-8000-0000000000a2";

const member = (role: OrganizationMembership["role"]): OrganizationMembership => ({
  tenantId: TENANT,
  slug: "demo-norte",
  displayName: "Municipio Demo Norte",
  role,
  tenantStatus: "active",
});

const paragraph = (text: string): RichText => [
  { type: "paragraph", children: [{ type: "text", text }] },
];

const review: CopilotReviewRow[] = [
  {
    kind: "destination",
    contentId: MUSEO,
    slug: "museo",
    tourId: null,
    sceneId: null,
    title: "Museo",
    sceneTitle: null,
    status: "changed",
    issues: ["unpublished_changes", "summary_short", "cover_missing"],
  },
];

const snapshot: CopilotSnapshotData = {
  timezone: "America/La_Paz",
  items: [
    {
      kind: "destination",
      contentId: MUSEO,
      slug: "museo",
      title: "Museo",
      summary: "Un museo.",
      status: "changed",
      schedule: null,
      ended: false,
      tour: null,
    },
  ],
};

const passage: KnowledgePassage = {
  chunkId: "aaaaaaaa-0000-4000-8000-0000000000e1",
  source: "content",
  sourceId: "aaaaaaaa-0000-4000-8000-0000000000f1",
  sourceVersion: 1,
  kind: "knowledge",
  slug: "guia",
  title: "Guía para visitantes",
  heading: "Historia",
  text: "El museo guarda herramientas de los abuelos.",
  pages: null,
  sceneId: null,
  hotspotId: null,
  ended: false,
  score: 1,
};

function ledger() {
  const begun: Parameters<AiLedger["begin"]>[0][] = [];
  const value: AiLedger = {
    async begin(input) {
      begun.push(input);
      return { requestId: "11111111-0000-4000-8000-000000000001", outcome: "reserved" };
    },
    async finish() {},
  };
  return { value, begun };
}

function runner(provider: AiProvider = createSimulatedAiProvider()) {
  const l = ledger();
  const ai: CopilotAiRunner = (input, work) =>
    runAiSession(input, { ledger: l.value, provider }, work);
  return { ai, begun: l.begun };
}

function copilotRepo(overrides: Partial<CopilotRepository> = {}) {
  const created: Parameters<CopilotRepository["createProposal"]>[0][] = [];
  const repo: CopilotRepository = {
    review: async () => review,
    snapshot: async () => snapshot,
    createProposal: async (input) => {
      created.push(input);
      return { status: "created", proposalId: "22222222-0000-4000-8000-000000000001" };
    },
    listProposals: async () => [],
    proposal: async () => null,
    accept: async () => ({ status: "accepted", revisionNo: 2, editCount: 3 }),
    reject: async () => ({ status: "rejected" }),
    ...overrides,
  };
  return { repo, created };
}

const knowledge = (found: KnowledgePassage[] = [passage]) =>
  ({ search: async () => found }) as unknown as KnowledgeRepository;

function destination(): DestinationRecord {
  const document = {
    ...emptyDestinationDocument("Museo"),
    summary: "Un museo.",
    body: paragraph("Texto [enlace](https://museo.example.test)."),
  };
  document.body = [
    {
      type: "paragraph",
      children: [
        { type: "text", text: "Texto con " },
        {
          type: "link",
          href: "https://museo.example.test",
          children: [{ type: "text", text: "enlace" }],
        },
      ],
    },
  ];
  return {
    contentId: MUSEO,
    tenantId: TENANT,
    slug: "museo",
    draft: {
      revisionId: DRAFT,
      revisionNo: 2,
      editCount: 4,
      updatedAt: "2026-11-04T10:00:00Z",
      document,
    },
    published: { revisionId: PUBLISHED, revisionNo: 1, document },
    history: [],
  };
}

const content = (record: DestinationRecord | null = destination()) =>
  ({
    findDestination: async () => record,
    findEvent: async () => null,
  }) as unknown as ContentRepository;

const tours = { find: async () => null } as unknown as TourRepository;

describe("Copilot domain (ADR-042)", () => {
  it("diffs by words: what stays, goes and comes", () => {
    expect(wordDiff("Un museo pequeño.", "Un museo grande y antiguo.")).toEqual([
      { kind: "same", text: "Un museo " },
      { kind: "removed", text: "pequeño." },
      { kind: "added", text: "grande y antiguo." },
    ]);
    expect(wordDiff("igual", "igual")).toEqual([{ kind: "same", text: "igual" }]);
    expect(wordDiff("", "nuevo")).toEqual([{ kind: "added", text: "nuevo" }]);
  });

  it("knows which findings the Copilot can help write", () => {
    expect(proposableFields(review[0] as CopilotReviewRow)).toEqual(["summary"]);
    expect(
      proposableFields({
        ...(review[0] as CopilotReviewRow),
        issues: ["scene_description_missing"],
      }),
    ).toEqual(["description"]);
    expect(
      proposableFields({ ...(review[0] as CopilotReviewRow), issues: ["cover_missing"] }),
    ).toEqual([]);
  });

  it("reads the target only from well-formed ids", () => {
    expect(proposalTargetFromQuery({ contenido: MUSEO })).toEqual({
      type: "content",
      contentId: MUSEO,
    });
    expect(proposalTargetFromQuery({ tour: MUSEO, escena: DRAFT })).toEqual({
      type: "scene",
      tourId: MUSEO,
      sceneId: DRAFT,
    });
    expect(proposalTargetFromQuery({ contenido: "x' or 1=1" })).toBeNull();
    expect(proposalTargetFromQuery({ tour: MUSEO })).toBeNull();
  });

  it("reads a proposal: only the fields asked, each valid for the database", () => {
    const text = [
      "**NOMBRE:** «Museo de la memoria»",
      "RESUMEN: Un museo con herramientas de los abuelos, salas para recorrer en familia y un patio con horno.",
      "DESCRIPCION: no la pedí",
      "TEXTO:",
      "## Qué ver",
      "Herramientas y [más](https://inventada.example.test).",
      "",
      "- Sala principal",
      "FIN_TEXTO",
      "FUENTES: A, F1",
    ].join("\n");
    const parsed = parseProposal(text, ["title", "summary", "body"]);
    expect(parsed.values.title).toBe("Museo de la memoria");
    expect(parsed.values.summary).toMatch(/^Un museo con herramientas/u);
    expect(parsed.values).not.toHaveProperty("description");
    // An invented link becomes plain text.
    expect(JSON.stringify(parsed.values.body)).not.toContain("inventada");
    expect(parsed.values.body).toEqual([
      { type: "heading", level: 2, children: [{ type: "text", text: "Qué ver" }] },
      {
        type: "paragraph",
        children: [
          { type: "text", text: "Herramientas y " },
          { type: "text", text: "más" },
          { type: "text", text: "." },
        ],
      },
      { type: "list", ordered: false, items: [[{ type: "text", text: "Sala principal" }]] },
    ]);
    expect(parsed.labels).toEqual(["A", "F1"]);
  });

  it("a line of the text that starts like a label is still text", () => {
    const parsed = parseProposal(
      "RESUMEN: Un resumen suficientemente largo para el museo del valle.\nTEXTO:\nTexto del museo.\nResumen: la historia del valle.\nFIN_TEXTO\nFUENTES: A",
      ["summary", "body"],
    );
    expect(parsed.values.summary).toBe("Un resumen suficientemente largo para el museo del valle.");
    expect(parsed.values.body).toEqual([
      {
        type: "paragraph",
        children: [{ type: "text", text: "Texto del museo. Resumen: la historia del valle." }],
      },
    ]);
  });

  it("drops a field with a placeholder, too long or missing", () => {
    const parsed = parseProposal(
      `NOMBRE: ${"x".repeat(130)}\nRESUMEN: Abre de [completar] a [completar].\nFUENTES: A`,
      ["title", "summary", "body"],
    );
    expect(parsed.values).toEqual({});
    expect(parsed.dropped).toEqual(["title", "summary", "body"]);
  });

  it("cuts a long summary at a sentence, never mid-word", () => {
    const sentence = "Un lugar tranquilo para visitar en familia y conocer la historia del valle. ";
    const parsed = parseProposal(`RESUMEN: ${sentence.repeat(6)}`, ["summary"]);
    const summary = parsed.values.summary as string;
    expect(summary.length).toBeLessThanOrEqual(300);
    expect(summary.endsWith("valle.")).toBe(true);
  });

  it("reads an answer without labels nor links, and its sources", () => {
    const parsed = parseCopilotAnswer(
      "Al [C1] le falta el resumen (C1, U). Ver https://x.example.test\n- Revisa la portada.\nFUENTES: C1, U, Z9",
    );
    expect(parsed.blocks).toEqual([
      { type: "paragraph", text: "Al le falta el resumen. Ver" },
      { type: "list", items: ["Revisa la portada."] },
    ]);
    expect(parsed.labels).toEqual(["C1", "U"]);
  });

  it("says the plan's usage in words, and that visits are not measured", () => {
    expect(
      usageLines({
        meters: [
          {
            resource: "storage_bytes",
            limit: 300 * 1024 * 1024,
            reserved: 0,
            consumed: 12 * 1024 * 1024,
            periodStart: null,
            periodEnd: null,
            share: 0.04,
            level: "ok",
            available: 0,
          },
        ],
        ai: { used: 1614, limit: 40_000 },
      }),
    ).toEqual([
      "Almacenamiento: 12 MB de 300 MB.",
      "IA hoy: 1614 de 40.000 tokens.",
      "Visitas y estadísticas de visitantes: la plataforma todavía no las mide.",
    ]);
  });
});

describe("Copilot V1 — review and questions", () => {
  it("analysts read the review but not the proposals", async () => {
    const { repo } = copilotRepo();
    expect(canPropose(member("analyst"))).toBe(false);
    expect(await loadCopilot(member("analyst"), repo)).toEqual({ review, proposals: null });
    expect((await loadCopilot(member("editor"), repo)).proposals).toEqual([]);
  });

  it("answers from the snapshot and links each source to the panel", async () => {
    const { repo } = copilotRepo();
    const { ai, begun } = runner();
    const answer = await askCopilot(
      member("analyst"),
      ACTOR,
      { question: "¿Qué le falta al museo?" },
      {
        copilot: repo,
        knowledge: knowledge(),
        usage: async () => ["Almacenamiento: 1 MB de 300 MB."],
        ai,
      },
    );
    expect(answer.status).toBe("answered");
    if (answer.status !== "answered") return;
    expect(answer.sources).toEqual([
      { label: "Destino", title: "Museo", href: `/o/demo-norte/destinos/${MUSEO}` },
      { label: "Uso del plan", title: "Uso del plan", href: "/o/demo-norte/uso" },
    ]);
    expect(begun[0]).toMatchObject({
      tenantId: TENANT,
      profile: "copilot",
      actorId: ACTOR,
      visitor: null,
    });
  });

  it("the model reads drafts, findings and usage as data, with the platform's numbers", async () => {
    const { repo } = copilotRepo();
    let read = "";
    const provider: AiProvider = {
      name: "spy",
      model: "spy",
      async complete(request) {
        read = request.messages.map((message) => message.content).join("\n");
        return { text: "Bien.\nFUENTES: ninguna", inputTokens: 1, outputTokens: 1, model: "spy" };
      },
    };
    await askCopilot(
      member("editor"),
      ACTOR,
      { question: "¿Qué falta?" },
      {
        copilot: repo,
        knowledge: knowledge([]),
        usage: async () => ["Almacenamiento: 1 MB de 300 MB."],
        ai: runner(provider).ai,
      },
    );
    expect(read).toContain("[C1] Destino «Museo» · publicado, con cambios sin publicar");
    expect(read).toContain("Le falta: resumen muy corto; sin foto de portada.");
    expect(read).toContain("Almacenamiento: 1 MB de 300 MB.");
    expect(read).toContain("No puedes publicar, enviar correos");
  });

  it("drops invented sources", async () => {
    const { repo } = copilotRepo();
    const answer = await askCopilot(
      member("editor"),
      ACTOR,
      { question: "[simular:cita-inventada]" },
      {
        copilot: repo,
        knowledge: knowledge([]),
        usage: async () => [],
        ai: runner().ai,
      },
    );
    expect(answer).toMatchObject({ status: "answered", sources: [] });
  });

  it("without AI it says so, and the review keeps working", async () => {
    const { repo } = copilotRepo();
    const ai: CopilotAiRunner = async () => ({ outcome: "tenant_quota", requestId: null });
    expect(
      await askCopilot(
        member("editor"),
        ACTOR,
        { question: "Hola" },
        {
          copilot: repo,
          knowledge: knowledge(),
          usage: async () => [],
          ai,
        },
      ),
    ).toEqual({ status: "notice", message: COPILOT_NOTICES.tenant_quota });
  });

  it("rejects an empty or huge question before spending anything", async () => {
    const { repo } = copilotRepo();
    const { ai, begun } = runner();
    const deps = { copilot: repo, knowledge: knowledge(), usage: async () => [], ai };
    expect(await askCopilot(member("editor"), ACTOR, { question: " " }, deps)).toEqual({
      status: "invalid",
    });
    expect(await askCopilot(member("editor"), ACTOR, { question: "x".repeat(501) }, deps)).toEqual({
      status: "invalid",
    });
    expect(begun).toHaveLength(0);
  });
});

describe("Copilot V2 — proposals", () => {
  const target = { type: "content", contentId: MUSEO } as const;

  it("an analyst cannot propose", async () => {
    const { repo, created } = copilotRepo();
    const { ai, begun } = runner();
    expect(
      await proposeWithCopilot(
        member("analyst"),
        ACTOR,
        { target, fields: ["summary"], style: "improve" },
        {
          copilot: repo,
          content: content(),
          tours,
          knowledge: knowledge(),
          ai,
        },
      ),
    ).toEqual({ status: "forbidden" });
    expect(begun).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it("proposes on the open draft, with its edit number and the request behind it", async () => {
    const { repo, created } = copilotRepo();
    const result = await proposeWithCopilot(
      member("editor"),
      ACTOR,
      { target, fields: ["title", "summary", "body"], style: "longer", words: "Menciona el patio" },
      { copilot: repo, content: content(), tours, knowledge: knowledge(), ai: runner().ai },
    );
    expect(result).toEqual({
      status: "created",
      proposalId: "22222222-0000-4000-8000-000000000001",
    });
    const input = created[0];
    expect(input).toMatchObject({
      tenantId: TENANT,
      target,
      baseRevisionId: DRAFT,
      baseEdit: 4,
      instruction: "Menciona el patio",
      aiRequestId: "11111111-0000-4000-8000-000000000001",
      sources: [{ label: "Documento", title: "Guía para visitantes · Historia" }],
    });
    // The title came back unchanged: only what changes is proposed.
    expect(Object.keys(input?.changes ?? {}).sort()).toEqual(["body", "summary"]);
  });

  it("on a published item without a draft, the base is the published revision", async () => {
    const record = { ...destination(), draft: null };
    const { repo, created } = copilotRepo();
    await proposeWithCopilot(
      member("owner"),
      ACTOR,
      { target, fields: ["summary"], style: "improve" },
      {
        copilot: repo,
        content: content(record),
        tours,
        knowledge: knowledge(),
        ai: runner().ai,
      },
    );
    expect(created[0]).toMatchObject({ baseRevisionId: PUBLISHED, baseEdit: null });
  });

  it("nothing new to propose is a notice, not an empty proposal", async () => {
    const { repo, created } = copilotRepo();
    const result = await proposeWithCopilot(
      member("editor"),
      ACTOR,
      { target, fields: ["summary"], style: "improve", words: "[simular:sin-cambios]" },
      { copilot: repo, content: content(), tours, knowledge: knowledge(), ai: runner().ai },
    );
    expect(result).toEqual({ status: "notice", message: COPILOT_NOTICES.nothing });
    expect(created).toHaveLength(0);
  });

  it("rejects fields of another kind of target, unknown styles and long words", async () => {
    const { repo } = copilotRepo();
    const deps = {
      copilot: repo,
      content: content(),
      tours,
      knowledge: knowledge(),
      ai: runner().ai,
    };
    for (const input of [
      { target, fields: ["description"], style: "improve" },
      { target, fields: ["summary"], style: "publicar" },
      { target, fields: ["summary", "summary"], style: "improve" },
      { target, fields: ["summary"], style: "improve", words: "x".repeat(301) },
    ]) {
      expect(await proposeWithCopilot(member("editor"), ACTOR, input, deps)).toEqual({
        status: "invalid",
      });
    }
  });

  it("an unknown item is not found (and the model is never called)", async () => {
    const { repo } = copilotRepo();
    const { ai, begun } = runner();
    expect(
      await proposeWithCopilot(
        member("editor"),
        ACTOR,
        { target, fields: ["summary"], style: "improve" },
        {
          copilot: repo,
          content: content(null),
          tours,
          knowledge: knowledge(),
          ai,
        },
      ),
    ).toEqual({ status: "not_found" });
    expect(begun).toHaveLength(0);
  });

  it("a base that changed meanwhile is stale", async () => {
    const { repo } = copilotRepo({ createProposal: async () => ({ status: "stale" }) });
    expect(
      await proposeWithCopilot(
        member("editor"),
        ACTOR,
        { target, fields: ["summary"], style: "improve" },
        {
          copilot: repo,
          content: content(),
          tours,
          knowledge: knowledge(),
          ai: runner().ai,
        },
      ),
    ).toEqual({ status: "stale" });
  });

  it("accepting checks the role and the fields before the database", async () => {
    const { repo } = copilotRepo();
    expect(
      await acceptProposal(member("analyst"), { proposalId: "p", fields: ["summary"] }, repo),
    ).toEqual({
      status: "forbidden",
    });
    expect(await acceptProposal(member("editor"), { proposalId: "p", fields: [] }, repo)).toEqual({
      status: "invalid",
    });
    expect(
      await acceptProposal(
        member("editor"),
        { proposalId: "p", fields: ["location" as ProposalField] },
        repo,
      ),
    ).toEqual({ status: "invalid" });
    expect(
      await acceptProposal(member("editor"), { proposalId: "p", fields: ["summary"] }, repo),
    ).toEqual({
      status: "accepted",
      revisionNo: 2,
      editCount: 3,
    });
  });
});

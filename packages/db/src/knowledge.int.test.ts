/**
 * The assistant's knowledge against a REAL local Supabase stack (ADR-037): a PDF uploaded
 * through a signed URL is read by the real extractor, a knowledge item that uses it is
 * published and indexed by the real indexer, and members (and the AI role) find it with its
 * pages — until it is retired, at once. Another municipality never sees it, and every
 * published source of the seed (destinations, events, tours) is indexed without errors.
 */
import { drainJobs, requestDocumentUpload, type OrganizationMembership } from "@rikuy/core";
import { createExtractDocumentProcessor, createIndexKnowledgeProcessor } from "@rikuy/worker";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { env, signIn, stackAvailable, USERS } from "./integration/local-stack";
import { createPostgresJobLedger } from "./job-ledger";
import { createKnowledgeRepository } from "./knowledge";
import { createMediaRepository, createSupabaseMediaAdmin } from "./media";
import { createPdfTextReader } from "./pdf-text";
import { syntheticPdf } from "./testing/pdf-fixture";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";

describe.runIf(stackAvailable)("the assistant's knowledge against local Supabase", () => {
  const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
  const admin = createSupabaseMediaAdmin({ url: env.url, secretKey: env.secretKey });
  let owner: Awaited<ReturnType<typeof signIn>>;
  let stranger: Awaited<ReturnType<typeof signIn>>;
  const membership = { tenantId: SUR, role: "owner" } as OrganizationMembership;

  async function drain() {
    const ledger = createPostgresJobLedger({
      url: DB_URL,
      role: "rikuy_worker",
      maxConnections: 2,
    });
    try {
      await drainJobs({
        ledger,
        processors: [
          createExtractDocumentProcessor({
            documents: ledger.documents,
            pdf: createPdfTextReader(),
            media: admin,
          }),
          createIndexKnowledgeProcessor({ knowledge: ledger.knowledge, media: admin }),
        ],
        runnerId: "it-knowledge",
        budgetMs: 30_000,
        concurrency: 2,
      });
    } finally {
      await ledger.close();
    }
  }

  beforeAll(async () => {
    if (env.secretKey === "") throw new Error("SUPABASE_SECRET_KEY is required");
    owner = await signIn(USERS.ownerSur);
    stranger = await signIn(USERS.ownerNorte);
  });

  afterAll(async () => {
    await db.end({ timeout: 5 });
  });

  it("reads a PDF, indexes a published knowledge item and stops using it when retired", async () => {
    const knowledge = createKnowledgeRepository(owner.client);
    const pdf = syntheticPdf([
      { lines: ["Historia del valle"] },
      {
        lines: [
          "La Reforma Agraria se firmo en 1953 y los campesinos del valle",
          "celebraron con una gran concentracion en la plaza del pueblo.",
          "Desde entonces cada 2 de agosto se recuerda el Dia del Campesino.",
        ],
      },
    ]);
    const request = await requestDocumentUpload(
      membership,
      { mime: "application/pdf", bytes: pdf.byteLength },
      createMediaRepository(owner.client),
    );
    expect(request.status).toBe("upload");
    if (request.status !== "upload") return;
    const sent = await fetch(request.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "application/pdf" },
      body: pdf,
    });
    expect(sent.ok).toBe(true);
    expect(await knowledge.submitDocument(SUR, request.versionId)).toBe("processing");
    await drain();
    const document = await knowledge.findDocument(SUR, request.assetId, request.version);
    expect(document).toMatchObject({ status: "ready", manifest: { format: "pdf", pages: 2 } });

    const created = await knowledge.create(SUR, `historia-${Date.now()}`, "Historia del valle");
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    // A new item opens its draft right away (edit 1).
    const opened = await knowledge.find(SUR, created.contentId);
    const saved = await knowledge.saveDraft(
      SUR,
      created.contentId,
      {
        title: "Historia del valle",
        summary: "Un resumen.",
        body: [],
        document: { assetId: request.assetId, version: request.version },
      },
      opened?.draft?.editCount ?? null,
    );
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") return;
    expect(await knowledge.publish(SUR, created.contentId, saved.editCount)).toMatchObject({
      status: "published",
    });
    await drain();

    const found = await knowledge.search(SUR, "¿Cuándo se firmó la Reforma Agraria?", 8);
    const ours = found.find((passage) => passage.sourceId === created.contentId);
    expect(ours).toMatchObject({
      source: "content",
      sourceId: created.contentId,
      sourceVersion: 1,
      kind: "knowledge",
      title: "Historia del valle",
      pages: { from: 1, to: 2 },
    });
    expect(ours?.text).toContain("1953");

    const [assistant] = await db.begin(async (sql) => {
      await sql`set local role rikuy_ai`;
      return sql`select count(*)::int as n from ai_api.search_knowledge(${SUR}::uuid, 'reforma agraria')`;
    });
    expect(assistant?.n).toBeGreaterThanOrEqual(1);

    await expect(
      createKnowledgeRepository(stranger.client).search(SUR, "reforma", 8),
    ).rejects.toThrow();
    expect(
      (
        await createKnowledgeRepository(stranger.client).search(
          "5eed1000-0000-4000-8000-000000000001",
          "reforma agraria 1953",
          8,
        )
      ).filter((passage) => passage.sourceId === created.contentId),
    ).toEqual([]);

    expect(await knowledge.retire(SUR, created.contentId)).toEqual({ status: "retired" });
    expect(
      (await knowledge.search(SUR, "reforma agraria 1953", 8)).filter(
        (passage) => passage.sourceId === created.contentId,
      ),
    ).toEqual([]);
  });

  it("indexes every published destination, event and tour of the seed without errors", async () => {
    // Other suites may have dead-lettered the seed's jobs (D-01 clears the queue): index the
    // current revisions again under keys of this run.
    const run = Date.now();
    await db`
      select private.enqueue_job(i.tenant_id, 'knowledge.index',
        'content_revision:' || i.published_revision_id || ':it' || ${run}::text,
        jsonb_build_object('source', 'content', 'revisionId', i.published_revision_id),
        'content_revision', i.published_revision_id)
      from public.content_items i where i.tenant_id = ${SUR} and i.published_revision_id is not null
    `;
    await db`
      select private.enqueue_job(t.tenant_id, 'knowledge.index',
        'tour_revision:' || t.published_revision_id || ':it' || ${run}::text,
        jsonb_build_object('source', 'tour', 'revisionId', t.published_revision_id),
        'tour_revision', t.published_revision_id)
      from public.tours t where t.tenant_id = ${SUR} and t.published_revision_id is not null
    `;
    await drain();
    const [failed] = await db`
      select count(*)::int as n from public.background_jobs
      where kind = 'knowledge.index' and status = 'dead_letter' and last_error_code <> 'test_cleanup'
    `;
    expect(failed?.n).toBe(0);
    const status = await createKnowledgeRepository(owner.client).indexStatus(SUR);
    expect(status.some((entry) => entry.source === "tour")).toBe(true);
    expect(status.filter((entry) => entry.chunks === null)).toEqual([]);
  });
});

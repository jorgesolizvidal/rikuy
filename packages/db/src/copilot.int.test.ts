/**
 * The staff's Copilot (P5 · Paso 7, ADR-042) against local Supabase, with the real
 * sessions of each role, the AI gateway's own role (rikuy_ai) and the simulated model. It
 * works on a destination and a tour created here in Demo Sur (the seed of Demo Norte stays
 * as RC-15 and the portals read it):
 *
 * - V1: an analyst reads the review and asks; the answer cites only this municipality.
 * - V2: the owner asks for a proposal; it is saved on the current base, and accepting the
 *   ticked fields saves a DRAFT (nothing is published). A proposal over an old revision is
 *   refused (RC of P5 · Paso 7). A scene of a published tour gets its description the same
 *   way. The owner of another municipality sees and touches nothing.
 */
import { randomUUID } from "node:crypto";

import {
  askCopilot,
  createSimulatedAiProvider,
  emptyDestinationDocument,
  proposeWithCopilot,
  runAiSession,
  type CopilotAiRunner,
} from "@rikuy/core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresAiLedger } from "./ai-ledger";
import { createContentRepository } from "./content";
import { createCopilotRepository } from "./copilot";
import { signIn, stackAvailable, USERS } from "./integration/local-stack";
import { createKnowledgeRepository } from "./knowledge";
import { createTourRepository } from "./tours";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const MANIFEST = {
  version: 1,
  projection: "equirectangular",
  source: { width: 4096, height: 2048, bytes: 900_000, mime: "image/jpeg", sha256: "a".repeat(64) },
  preview: { file: "preview.webp", width: 1024, height: 512, bytes: 18_000 },
  image: { file: "image.webp", width: 4096, height: 2048, bytes: 1_400_000 },
  tiles: null,
};

describe.runIf(stackAvailable)("the Copilot against local Supabase", () => {
  const admin = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
  const ledger = createPostgresAiLedger({ url: DB_URL, role: "rikuy_ai", maxConnections: 1 });
  const provider = createSimulatedAiProvider();
  const ai: CopilotAiRunner = (input, work) => runAiSession(input, { ledger, provider }, work);
  let owner: Awaited<ReturnType<typeof signIn>>;
  let analyst: Awaited<ReturnType<typeof signIn>>;
  let stranger: Awaited<ReturnType<typeof signIn>>;
  let contentId = "";
  let tourId = "";
  let sceneId = "";
  const membership = (role: "owner" | "analyst") => ({
    tenantId: SUR,
    slug: "demo-sur",
    displayName: "Municipio Demo Sur",
    role,
    tenantStatus: "active" as const,
  });
  const deps = (session: Awaited<ReturnType<typeof signIn>>) => ({
    copilot: createCopilotRepository(session.client),
    content: createContentRepository(session.client),
    tours: createTourRepository(session.client),
    knowledge: createKnowledgeRepository(session.client),
    ai,
  });

  beforeAll(async () => {
    owner = await signIn(USERS.ownerSur);
    analyst = await signIn(USERS.both); // analyst in Demo Sur
    stranger = await signIn(USERS.ownerNorte);
    const content = createContentRepository(owner.client);
    const created = await content.createDestination(
      SUR,
      `copilot-${randomUUID().slice(0, 8)}`,
      "Mirador del copilot",
    );
    if (created.status !== "created") throw new Error(`destination: ${created.status}`);
    contentId = created.contentId;
    const saved = await content.saveDraft(
      SUR,
      contentId,
      {
        ...emptyDestinationDocument("Mirador del copilot"),
        summary: "Un mirador.",
        location: { lat: -17.5, lng: -66.2 },
      },
      1,
    );
    if (saved.status !== "saved") throw new Error(`save: ${saved.status}`);
    const published = await content.publish(SUR, contentId, saved.editCount);
    if (published.status !== "published") throw new Error(`publish: ${published.status}`);

    const asset = randomUUID();
    const version = randomUUID();
    await admin`insert into public.assets (id, tenant_id, purpose) values (${asset}, ${SUR}, 'panorama')`;
    await admin`
      insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                         mime, bytes, width, height, sha256, ready_at, manifest, published_at)
      values (${version}, ${SUR}, ${asset}, 1, 'ready', 'image/jpeg', 1000, 'image/jpeg', 1000, 4096, 2048,
              ${"b".repeat(64)}, now(), ${admin.json(MANIFEST)}, now())
    `;
    const tours = createTourRepository(owner.client);
    const tour = await tours.create(SUR, contentId);
    if (tour.status !== "created") throw new Error(`tour: ${tour.status}`);
    tourId = tour.tourId;
    const scene = await tours.addScene(SUR, tourId, 1, version, "Vista al valle");
    if (scene.status !== "saved") throw new Error(`scene: ${scene.status}`);
    const record = await tours.find(SUR, tourId);
    sceneId = record?.draft?.scenes[0]?.sceneId ?? "";
    const done = await tours.publish(SUR, tourId, scene.editCount);
    if (done.status !== "published") throw new Error(`publish tour: ${done.status}`);
  });

  afterAll(async () => {
    await ledger.close();
    await admin.end({ timeout: 5 });
  });

  it("V1: an analyst reads the review and asks; the answer cites only this municipality", async () => {
    const review = await createCopilotRepository(analyst.client).review(SUR);
    const row = review.find((entry) => entry.contentId === contentId && entry.sceneId === null);
    expect(row?.issues).toEqual([
      "summary_short",
      "body_missing",
      "cover_missing",
      "hours_missing",
    ]);
    expect(review.some((entry) => entry.sceneId === sceneId)).toBe(true);

    const answer = await askCopilot(
      membership("analyst"),
      analyst.actor.userId,
      { question: "¿Qué está incompleto?" },
      {
        ...deps(analyst),
        usage: async () => [],
      },
    );
    expect(answer.status).toBe("answered");
    if (answer.status !== "answered") return;
    for (const source of answer.sources) {
      if (source.href) expect(source.href.startsWith("/o/demo-sur/")).toBe(true);
    }
    // The request was the analyst's, of the Copilot, in Demo Sur.
    const [request] = await admin`
      select profile, status, actor_id from public.ai_requests
      where tenant_id = ${SUR} order by created_at desc limit 1`;
    expect(request).toMatchObject({
      profile: "copilot",
      status: "completed",
      actor_id: analyst.actor.userId,
    });
  });

  it("V1: another municipality's owner reads nothing of Demo Sur", async () => {
    await expect(createCopilotRepository(stranger.client).review(SUR)).rejects.toThrow(/42501/u);
    expect(
      await createCopilotRepository(analyst.client)
        .listProposals(SUR)
        .catch((error) => String(error)),
    ).toMatch(/42501/u);
  });

  it("V2: a proposal saves only a draft, and one over an old revision is refused", async () => {
    const copilot = createCopilotRepository(owner.client);
    const first = await proposeWithCopilot(
      membership("owner"),
      owner.actor.userId,
      { target: { type: "content", contentId }, fields: ["summary", "body"], style: "longer" },
      deps(owner),
    );
    expect(first.status).toBe("created");
    const second = await proposeWithCopilot(
      membership("owner"),
      owner.actor.userId,
      { target: { type: "content", contentId }, fields: ["summary"], style: "improve" },
      deps(owner),
    );
    expect(second.status).toBe("created");
    if (first.status !== "created" || second.status !== "created") return;

    const view = await copilot.proposal(SUR, first.proposalId);
    expect(view?.changes.summary?.from).toBe("Un mirador.");
    expect(view?.stale).toBe(false);

    expect(await copilot.accept(SUR, first.proposalId, ["summary"])).toEqual({
      status: "accepted",
      revisionNo: 2,
      editCount: 1,
    });
    const record = await createContentRepository(owner.client).findDestination(SUR, contentId);
    expect(record?.draft?.document.summary).toMatch(/^Resumen propuesto por el Copilot/u);
    expect(record?.draft?.document.body).toEqual([]); // the body was not ticked
    expect(record?.published?.document.summary).toBe("Un mirador."); // nothing published

    // Made on the published revision; a draft exists now: refused, nothing changes.
    expect(
      (await copilot.listProposals(SUR)).find((entry) => entry.id === second.proposalId)?.stale,
    ).toBe(true);
    expect(await copilot.accept(SUR, second.proposalId, ["summary"])).toEqual({ status: "stale" });
    expect(await copilot.accept(SUR, first.proposalId, ["summary"])).toEqual({ status: "decided" });
    expect(await copilot.reject(SUR, second.proposalId)).toEqual({ status: "rejected" });

    // The other municipality's owner cannot touch it, from either municipality.
    const theirs = createCopilotRepository(stranger.client);
    expect(
      await theirs.proposal("5eed1000-0000-4000-8000-000000000001", first.proposalId),
    ).toBeNull();
    expect(await theirs.accept(SUR, first.proposalId, ["summary"])).toEqual({
      status: "forbidden",
    });
  });

  it("V2: an analyst cannot propose (and the model is not called)", async () => {
    const [beforeRow] = await admin<{ count: number }[]>`
      select count(*)::int as count from public.ai_requests where tenant_id = ${SUR}`;
    expect(
      await proposeWithCopilot(
        membership("analyst"),
        analyst.actor.userId,
        { target: { type: "content", contentId }, fields: ["summary"], style: "improve" },
        deps(analyst),
      ),
    ).toEqual({ status: "forbidden" });
    const [afterRow] = await admin<{ count: number }[]>`
      select count(*)::int as count from public.ai_requests where tenant_id = ${SUR}`;
    expect(afterRow?.count).toBe(beforeRow?.count);
  });

  it("V2: a scene of the published tour gets its description in the tour's draft", async () => {
    const result = await proposeWithCopilot(
      membership("owner"),
      owner.actor.userId,
      { target: { type: "scene", tourId, sceneId }, fields: ["description"], style: "improve" },
      deps(owner),
    );
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    const accepted = await createCopilotRepository(owner.client).accept(SUR, result.proposalId, [
      "description",
    ]);
    expect(accepted.status).toBe("accepted");
    const tour = await createTourRepository(owner.client).find(SUR, tourId);
    expect(tour?.draft?.scenes[0]?.description).toMatch(/^Descripción propuesta por el Copilot/u);
    expect(tour?.published?.scenes[0]?.description).toBe("");
  });
});

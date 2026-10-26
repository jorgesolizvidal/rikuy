/**
 * Tours (P4 · Paso 1) against a REAL local Supabase stack, through the Data API with each
 * person's session: a tour of two scenes is published, a new draft of four keeps the
 * scene ids, rolling back brings the two-scene graph back with its own entry (RC-02), the
 * analyst only reads and another municipality's owner sees nothing. Demo Sur only (Demo
 * Norte stays as the seed left it, for RC-15). The panoramas are inserted ready by the
 * test: the pipeline has its own suite.
 */
import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createContentRepository } from "./content";
import { signIn, stackAvailable, USERS } from "./integration/local-stack";
import { createTourRepository } from "./tours";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const MANIFEST = {
  version: 1,
  projection: "equirectangular",
  source: {
    width: 8192,
    height: 4096,
    bytes: 9_000_000,
    mime: "image/jpeg",
    sha256: "a".repeat(64),
  },
  preview: { file: "preview.webp", width: 1024, height: 512, bytes: 18_000 },
  image: { file: "image.webp", width: 4096, height: 2048, bytes: 1_400_000 },
  tiles: null,
};

describe.runIf(stackAvailable)("tours against local Supabase", () => {
  const admin = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
  const panoramas: string[] = [];
  let owner: Awaited<ReturnType<typeof signIn>>;
  let analyst: Awaited<ReturnType<typeof signIn>>;
  let stranger: Awaited<ReturnType<typeof signIn>>;
  let contentId = "";
  const pano = (index: number) => {
    const version = panoramas[index];
    if (!version) throw new Error(`panorama ${index} missing`);
    return version;
  };

  beforeAll(async () => {
    for (let index = 0; index < 4; index += 1) {
      const asset = randomUUID();
      const version = randomUUID();
      await admin`insert into public.assets (id, tenant_id, purpose) values (${asset}, ${SUR}, 'panorama')`;
      await admin`
        insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                           mime, bytes, width, height, sha256, ready_at, manifest)
        values (${version}, ${SUR}, ${asset}, 1, 'ready', 'image/jpeg', 1000, 'image/jpeg', 1000, 8192, 4096,
                ${"b".repeat(64)}, now(), ${admin.json(MANIFEST)})
      `;
      // Inserted already ready: nothing is reserved against the quotas.
      panoramas.push(version);
    }
    owner = await signIn(USERS.ownerSur);
    analyst = await signIn(USERS.both); // analyst in Demo Sur
    stranger = await signIn(USERS.ownerNorte);
    const created = await createContentRepository(owner.client).createDestination(
      SUR,
      `recorrido-${randomUUID().slice(0, 8)}`,
      "Recorrido de prueba",
    );
    if (created.status !== "created") throw new Error(`destination: ${created.status}`);
    contentId = created.contentId;
  });

  afterAll(async () => {
    await admin.end({ timeout: 5 });
  });

  it("publishes two scenes, edits to four and rolls back to the two-scene graph", async () => {
    const tours = createTourRepository(owner.client);
    const created = await tours.create(SUR, contentId);
    if (created.status !== "created") throw new Error(`tour: ${created.status}`);
    const tourId = created.tourId;
    expect(await tours.create(SUR, contentId)).toEqual({ status: "exists" });

    let edit = (await tours.find(SUR, tourId))?.draft?.editCount ?? 0;
    const step = async (outcome: Promise<{ status: string; editCount?: number }>) => {
      const result = await outcome;
      if (result.status !== "saved" || result.editCount === undefined)
        throw new Error(result.status);
      edit = result.editCount;
    };
    await step(tours.addScene(SUR, tourId, edit, pano(0), "Entrada"));
    await step(tours.addScene(SUR, tourId, edit, pano(1), "Sala"));
    expect(await tours.addScene(SUR, tourId, edit - 1, pano(2), "Vieja")).toEqual({
      status: "conflict",
    });
    expect(await tours.addScene(SUR, tourId, edit, pano(0), "Repetida")).toEqual({
      status: "duplicate",
    });

    const first = await tours.find(SUR, tourId);
    const [entry, hall] = first?.draft?.scenes ?? [];
    if (!entry || !hall) throw new Error("scenes missing");
    expect(first?.draft?.entrySceneId).toBe(entry.sceneId);
    await step(
      tours.updateScene(SUR, tourId, edit, hall.sceneId, {
        description: "La sala principal",
        initialView: { yaw: 1.5, pitch: -0.2, fov: 70 },
      }),
    );
    await step(tours.updateScene(SUR, tourId, edit, hall.sceneId, { title: "Sala principal" }));
    const afterTitle = (await tours.find(SUR, tourId))?.draft?.scenes[1];
    expect(afterTitle).toMatchObject({
      title: "Sala principal",
      description: "La sala principal",
      initialView: { yaw: 1.5, pitch: -0.2, fov: 70 },
      panorama: { versionId: panoramas[1] },
    });

    expect(await tours.publish(SUR, tourId, edit)).toEqual({ status: "published", revisionNo: 1 });

    // A new draft (no open draft → null) copies the graph with the same scene ids.
    await step(tours.addScene(SUR, tourId, null, pano(2), "Patio"));
    await step(tours.addScene(SUR, tourId, edit, pano(3), "Torre"));
    const draft = (await tours.find(SUR, tourId))?.draft;
    expect(draft?.scenes.map((scene) => scene.sceneId).slice(0, 2)).toEqual([
      entry.sceneId,
      hall.sceneId,
    ]);
    const tower = draft?.scenes[3];
    if (!tower) throw new Error("tower missing");
    await step(tours.moveScene(SUR, tourId, edit, tower.sceneId, 0));
    await step(tours.setEntryScene(SUR, tourId, edit, tower.sceneId));
    expect(await tours.publish(SUR, tourId, edit)).toEqual({ status: "published", revisionNo: 2 });

    const two = await tours.find(SUR, tourId);
    expect(two?.published?.scenes.map((scene) => scene.title)).toEqual([
      "Torre",
      "Entrada",
      "Sala principal",
      "Patio",
    ]);
    const revisionOne = two?.history.find((revision) => revision.revisionNo === 1);
    if (!revisionOne) throw new Error("history missing");
    expect(await tours.restore(SUR, tourId, revisionOne.revisionId)).toEqual({
      status: "restored",
      revisionNo: 1,
    });
    const back = await tours.find(SUR, tourId);
    expect(back?.published?.entrySceneId).toBe(entry.sceneId);
    expect(back?.published?.scenes.map((scene) => scene.sceneId)).toEqual([
      entry.sceneId,
      hall.sceneId,
    ]);

    // The analyst reads, and cannot edit.
    const readOnly = createTourRepository(analyst.client);
    expect((await readOnly.list(SUR)).some((tour) => tour.tourId === tourId)).toBe(true);
    expect(await readOnly.addScene(SUR, tourId, null, pano(2), "X")).toEqual({
      status: "forbidden",
    });

    // Another municipality's owner does not see it, nor can create tours in Demo Sur.
    const other = createTourRepository(stranger.client);
    expect(await other.find(SUR, tourId)).toBeNull();
    expect(await other.create(SUR, contentId)).toEqual({ status: "forbidden" });
    const direct = await stranger.client
      .from("tour_scenes")
      .select("scene_id")
      .eq("tenant_id", SUR);
    expect(direct.data ?? []).toEqual([]);
  });
});

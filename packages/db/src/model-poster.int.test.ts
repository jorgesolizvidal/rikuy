/**
 * A new model poster reaches visitors (ADR-048, nota de la corrección) against a REAL local
 * Supabase stack: a tour is published with the model's first poster; a photo becomes the new
 * poster under its own name, the published tour gets a draft, and publishing it again copies
 * the new image to the public bucket and serves it, while the earlier revision keeps the old
 * one. Then a deleted model's files, in subfolders too, really leave Storage. Demo Sur only.
 */
import { randomUUID } from "node:crypto";

import { deleteTourMedia, publishTour, saveModelPoster } from "@rikuy/core";
import postgres from "postgres";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createContentRepository } from "./content";
import { env, signIn, stackAvailable, USERS } from "./integration/local-stack";
import {
  createMediaRepository,
  createSharpImageProcessor,
  createSupabaseMediaAdmin,
  publicMediaUrl,
} from "./media";
import { createMediaLibraryRepository } from "./media-library";
import { createModelRepository } from "./models";
import { createSupabasePublishedTourReader, createTourRepository } from "./tours";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const MODEL_MANIFEST = {
  version: 1,
  format: "glb",
  source: {
    bytes: 1000,
    sha256: "a".repeat(64),
    triangles: 12,
    vertices: 8,
    materials: 1,
    textures: 0,
    generator: "test",
    extensions: [],
  },
  model: { file: "model.glb", bytes: 4, triangles: 12, geometry: "meshopt", textures: [] },
  colors: { materials: "unchanged", vertexColors: null, suspects: [] },
  weight: "light",
  poster: null,
};

const image = (
  width: number,
  color: { r: number; g: number; b: number },
  format: "webp" | "jpeg",
) => {
  const base = sharp({
    create: { width, height: Math.round(width / 2), channels: 3, background: color },
  });
  return (format === "webp" ? base.webp() : base.jpeg()).toBuffer();
};

describe.runIf(stackAvailable)("model posters and deleted files against local Supabase", () => {
  const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
  const admin = createSupabaseMediaAdmin({ url: env.url, secretKey: env.secretKey });
  let owner: Awaited<ReturnType<typeof signIn>>;
  const pano = { asset: randomUUID(), version: randomUUID() };
  const model = { asset: randomUUID(), version: randomUUID() };

  async function insertVersion(
    target: { asset: string; version: string },
    purpose: "panorama" | "model",
    manifest: unknown,
  ) {
    await db`insert into public.assets (id, tenant_id, purpose) values (${target.asset}, ${SUR}, ${purpose})`;
    await db`
      insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                         mime, bytes, width, height, sha256, ready_at, manifest)
      values (${target.version}, ${SUR}, ${target.asset}, 1, 'ready',
              ${purpose === "model" ? "model/gltf-binary" : "image/jpeg"}, 1000,
              ${purpose === "model" ? "model/gltf-binary" : "image/jpeg"}, 1000,
              ${purpose === "model" ? null : 4096}, ${purpose === "model" ? null : 2048},
              ${"e".repeat(64)}, now(), ${db.json(manifest as never)})
    `;
  }

  beforeAll(async () => {
    if (env.secretKey === "") throw new Error("SUPABASE_SECRET_KEY is required");
    const [preview, full] = await Promise.all([
      image(256, { r: 90, g: 120, b: 160 }, "webp"),
      image(512, { r: 90, g: 120, b: 160 }, "webp"),
    ]);
    await insertVersion(pano, "panorama", {
      version: 1,
      projection: "equirectangular",
      source: {
        width: 4096,
        height: 2048,
        bytes: 1000,
        mime: "image/jpeg",
        sha256: "a".repeat(64),
      },
      preview: { file: "preview.webp", width: 256, height: 128, bytes: preview.length },
      image: { file: "image.webp", width: 512, height: 256, bytes: full.length },
      tiles: null,
    });
    await admin.storeDerivatives(`${SUR}/${pano.asset}/1/panorama/`, [
      { name: "preview.webp", bytes: new Uint8Array(preview), contentType: "image/webp" },
      { name: "image.webp", bytes: new Uint8Array(full), contentType: "image/webp" },
    ]);
    await insertVersion(model, "model", MODEL_MANIFEST);
    await admin.storeDerivatives(`${SUR}/${model.asset}/1/model/`, [
      {
        name: "model.glb",
        bytes: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
        contentType: "image/webp",
      },
    ]);
    owner = await signIn(USERS.ownerSur);
  });

  afterAll(async () => {
    await db.end({ timeout: 5 });
  });

  it("a new poster reaches visitors when the tour is published again", async () => {
    const membership = (await owner.reader.listActiveMemberships(owner.actor.userId)).find(
      (entry) => entry.tenantId === SUR,
    );
    if (!membership) throw new Error("no membership in Demo Sur");
    const posterDeps = {
      models: createModelRepository(owner.client),
      media: createMediaRepository(owner.client),
      admin,
      processor: createSharpImageProcessor(),
    };
    const poster = async (color: { r: number; g: number; b: number }) =>
      saveModelPoster(
        membership,
        { versionId: model.version, capture: new Uint8Array(await image(1600, color, "jpeg")) },
        posterDeps,
      );

    // The first poster (the panel's capture): no tour uses the model yet.
    expect(await poster({ r: 200, g: 40, b: 30 })).toEqual({
      status: "saved",
      tours: 0,
      openedDrafts: 0,
    });

    // A published destination with a tour that shows the model.
    const slug = `poster-${randomUUID().slice(0, 8)}`;
    const content = createContentRepository(owner.client);
    const created = await content.createDestination(SUR, slug, "Poster de prueba");
    if (created.status !== "created") throw new Error(created.status);
    const saved = await content.saveDraft(
      SUR,
      created.contentId,
      {
        title: "Poster de prueba",
        summary: "Un lugar",
        body: [],
        location: { lat: -17.39, lng: -66.15 },
        cover: null,
        gallery: [],
      },
      1,
    );
    if (saved.status !== "saved") throw new Error(saved.status);
    await content.publish(SUR, created.contentId, saved.editCount);
    const tours = createTourRepository(owner.client);
    const tour = await tours.create(SUR, created.contentId);
    if (tour.status !== "created") throw new Error(tour.status);
    const scene = await tours.addScene(SUR, tour.tourId, 1, pano.version, "Sala");
    if (scene.status !== "saved" || scene.editCount === undefined) throw new Error(scene.status);
    const sceneId = (await tours.find(SUR, tour.tourId))?.draft?.scenes[0]?.sceneId ?? "";
    const point = await tours.addHotspot(SUR, tour.tourId, scene.editCount, sceneId, {
      kind: "model",
      title: "Monumento",
      position: { yaw: 0, pitch: 0 },
      modelVersionId: model.version,
    });
    if (point.status !== "saved" || point.editCount === undefined) throw new Error(point.status);
    expect(
      await publishTour(
        membership,
        { tourId: tour.tourId, expectedEdit: point.editCount },
        { tours, media: admin },
      ),
    ).toMatchObject({ status: "published", revisionNo: 1 });

    const visitors = createSupabasePublishedTourReader({
      url: env.url,
      publishableKey: env.publishableKey,
    });
    const shownPoster = async () => {
      const published = await visitors.find(SUR, "destination", slug);
      const shown = published?.manifest.scenes[0]?.hotspots[0]?.model;
      if (!shown?.poster) throw new Error("no poster in the published tour");
      return `${shown.folder}${shown.poster.file}`;
    };
    const first = await shownPoster();
    expect(first).toMatch(/model\/poster-[0-9a-f]{8}\.webp$/u);

    // A photo as the new poster: own name, and the published tour gets a draft.
    expect(await poster({ r: 30, g: 160, b: 60 })).toEqual({
      status: "saved",
      tours: 1,
      openedDrafts: 1,
    });
    expect(await shownPoster()).toBe(first); // visitors: nothing changes yet
    const draft = (await tours.find(SUR, tour.tourId))?.draft;
    if (!draft) throw new Error("no draft was opened");
    expect(draft.scenes[0]?.hotspots[0]?.model?.versionId).toBe(model.version);

    expect(
      await publishTour(
        membership,
        { tourId: tour.tourId, expectedEdit: draft.editCount },
        { tours, media: admin },
      ),
    ).toMatchObject({ status: "published", revisionNo: 2 });
    const second = await shownPoster();
    expect(second).not.toBe(first);

    const green = await fetch(publicMediaUrl(env.url, second));
    expect(green.status).toBe(200);
    const [r, g] = (await sharp(Buffer.from(await green.arrayBuffer())).stats()).channels;
    expect(g?.mean ?? 0).toBeGreaterThan(r?.mean ?? 0); // the new (green) image
    // «Volver a esta versión» still has its image.
    expect((await fetch(publicMediaUrl(env.url, first))).status).toBe(200);
  });

  it("deleting a model removes its files, in subfolders too, from both buckets", async () => {
    const membership = (await owner.reader.listActiveMemberships(owner.actor.userId)).find(
      (entry) => entry.tenantId === SUR,
    );
    if (!membership) throw new Error("no membership in Demo Sur");
    const unused = { asset: randomUUID(), version: randomUUID() };
    await insertVersion(unused, "model", MODEL_MANIFEST);
    const prefix = `${SUR}/${unused.asset}/1/`;
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await admin.storeDerivatives(prefix, [{ name: "original", bytes, contentType: "image/webp" }]);
    await admin.storeDerivatives(`${prefix}model/`, [
      { name: "model.glb", bytes, contentType: "image/webp" },
      { name: "poster-0a1b2c3d.webp", bytes, contentType: "image/webp" },
    ]);
    await admin.storeDerivatives(`${prefix}model/work/`, [
      { name: "texture-0.ktx2", bytes, contentType: "image/webp" },
    ]);
    await admin.publishFiles(SUR, unused.asset, 1, ["model/model.glb"]);
    const objects = async () => {
      const [row] = await db<{ count: number }[]>`
        select count(*)::int as count from storage.objects where name like ${`${prefix}%`}`;
      return row?.count ?? -1;
    };
    expect(await objects()).toBe(5);

    expect(
      await deleteTourMedia(membership, unused.asset, createMediaLibraryRepository(owner.client)),
    ).toEqual({ status: "deleted" });
    // What the cleanup job does with the folder the ledger hands it.
    expect(await admin.removeVersionFolder(prefix)).toBe(5);
    expect(await objects()).toBe(0);
  });
});

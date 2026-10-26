/**
 * Publishing a tour against a REAL local Supabase stack (P4 · Paso 3): the panorama's files
 * are copied inside Storage to the public bucket before the revision is sealed, visitors
 * read the sealed manifest anonymously and the files answer at their public URL. Demo Sur
 * only (Demo Norte stays as the seed left it, for RC-15).
 */
import { randomUUID } from "node:crypto";

import { publishTour } from "@rikuy/core";
import postgres from "postgres";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createContentRepository } from "./content";
import { env, signIn, stackAvailable, USERS } from "./integration/local-stack";
import { createSupabaseMediaAdmin, publicMediaUrl } from "./media";
import { createSupabasePublishedTourReader, createTourRepository } from "./tours";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";

describe.runIf(stackAvailable)("tour publication against local Supabase", () => {
  const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
  let owner: Awaited<ReturnType<typeof signIn>>;
  const asset = randomUUID();
  const version = randomUUID();

  beforeAll(async () => {
    if (env.secretKey === "") throw new Error("SUPABASE_SECRET_KEY is required");
    const webp = (width: number) =>
      sharp({
        create: { width, height: width / 2, channels: 3, background: { r: 90, g: 120, b: 160 } },
      })
        .webp()
        .toBuffer();
    const [preview, image] = await Promise.all([webp(256), webp(512)]);
    const manifest = {
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
      image: { file: "image.webp", width: 512, height: 256, bytes: image.length },
      tiles: null,
    };
    await db`insert into public.assets (id, tenant_id, purpose) values (${asset}, ${SUR}, 'panorama')`;
    await db`
      insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                         mime, bytes, width, height, sha256, ready_at, manifest)
      values (${version}, ${SUR}, ${asset}, 1, 'ready', 'image/jpeg', 1000, 'image/jpeg', 1000, 4096, 2048,
              ${"d".repeat(64)}, now(), ${db.json(manifest)})
    `;
    // The pipeline's renditions, private until a tour is published.
    await createSupabaseMediaAdmin({ url: env.url, secretKey: env.secretKey }).storeDerivatives(
      `${SUR}/${asset}/1/panorama/`,
      [
        { name: "preview.webp", bytes: new Uint8Array(preview), contentType: "image/webp" },
        { name: "image.webp", bytes: new Uint8Array(image), contentType: "image/webp" },
      ],
    );
    owner = await signIn(USERS.ownerSur);
  });

  afterAll(async () => {
    await db.end({ timeout: 5 });
  });

  it("copies the media, seals the manifest and serves it to visitors", async () => {
    const slug = `museo-${randomUUID().slice(0, 8)}`;
    const content = createContentRepository(owner.client);
    const created = await content.createDestination(SUR, slug, "Museo de prueba");
    if (created.status !== "created") throw new Error(created.status);
    const saved = await content.saveDraft(
      SUR,
      created.contentId,
      {
        title: "Museo de prueba",
        summary: "Un museo",
        body: [],
        location: { lat: -17.39, lng: -66.15 },
        cover: null,
        gallery: [],
      },
      1,
    );
    if (saved.status !== "saved") throw new Error(saved.status);
    expect(await content.publish(SUR, created.contentId, saved.editCount)).toMatchObject({
      status: "published",
    });

    const tours = createTourRepository(owner.client);
    const tour = await tours.create(SUR, created.contentId);
    if (tour.status !== "created") throw new Error(tour.status);
    const added = await tours.addScene(SUR, tour.tourId, 1, version, "Sala");
    if (added.status !== "saved") throw new Error(added.status);

    const visitors = createSupabasePublishedTourReader({
      url: env.url,
      publishableKey: env.publishableKey,
    });
    expect(await visitors.find(SUR, "destination", slug)).toBeNull();

    const membership = (await owner.reader.listActiveMemberships(owner.actor.userId)).find(
      (m) => m.tenantId === SUR,
    );
    if (!membership) throw new Error("no membership in Demo Sur");
    const media = createSupabaseMediaAdmin({ url: env.url, secretKey: env.secretKey });
    expect(
      await publishTour(
        membership,
        { tourId: tour.tourId, expectedEdit: added.editCount },
        { tours, media },
      ),
    ).toEqual({
      status: "published",
      revisionNo: 1,
    });

    const [row] = await db`select published_at from public.asset_versions where id = ${version}`;
    expect(row?.published_at).not.toBeNull();

    const published = await visitors.find(SUR, "destination", slug);
    const scene = published?.manifest.scenes[0];
    expect(scene?.panorama.folder).toBe(`${SUR}/${asset}/1/panorama/`);
    for (const file of [scene?.panorama.preview.file, scene?.panorama.image.file]) {
      const response = await fetch(publicMediaUrl(env.url, `${scene?.panorama.folder}${file}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("image/webp");
    }
    expect((await visitors.index(SUR)).some((entry) => entry.slug === slug)).toBe(true);

    // Publishing again (a new version) copies nothing new and still works.
    const again = await tours.updateScene(SUR, tour.tourId, null, scene?.sceneId ?? "", {
      title: "Sala principal",
    });
    if (again.status !== "saved") throw new Error(again.status);
    expect(
      await publishTour(
        membership,
        { tourId: tour.tourId, expectedEdit: again.editCount },
        { tours, media },
      ),
    ).toEqual({
      status: "published",
      revisionNo: 2,
    });
  });
});

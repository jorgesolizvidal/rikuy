/**
 * Replacing and deleting panoramas (C0 · Paso 2, ADR-048) against a REAL local Supabase
 * stack, with each person's session: a new version of a panorama the published tour uses
 * goes to a new draft (visitors keep the old one), the panel learns where it is used, an
 * analyst and another municipality's owner are refused, a used panorama cannot be deleted
 * and an unused one is, leaving the list and handing its files to the cleanup job. Demo Sur
 * only. The pipeline is simulated (the version is set ready by the test): it has its own
 * suites.
 */
import { randomUUID } from "node:crypto";

import { applyMediaReplacement, deleteTourMedia, requestPanoramaUpload } from "@rikuy/core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createContentRepository } from "./content";
import { signIn, stackAvailable, USERS } from "./integration/local-stack";
import { createMediaRepository } from "./media";
import { createMediaLibraryRepository } from "./media-library";
import { createPanoramaRepository } from "./panoramas";
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

describe.runIf(stackAvailable)("replacing and deleting panoramas against local Supabase", () => {
  const admin = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
  let owner: Awaited<ReturnType<typeof signIn>>;
  let analyst: Awaited<ReturnType<typeof signIn>>;
  let stranger: Awaited<ReturnType<typeof signIn>>;
  const used = { asset: randomUUID(), version: randomUUID() };
  const unused = { asset: randomUUID(), version: randomUUID() };
  let tourId = "";

  beforeAll(async () => {
    for (const panorama of [used, unused]) {
      await admin`insert into public.assets (id, tenant_id, purpose) values (${panorama.asset}, ${SUR}, 'panorama')`;
      await admin`
        insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                           mime, bytes, width, height, sha256, ready_at, manifest, published_at)
        values (${panorama.version}, ${SUR}, ${panorama.asset}, 1, 'ready', 'image/jpeg', 1000, 'image/jpeg', 1000,
                8192, 4096, ${"b".repeat(64)}, now(), ${admin.json(MANIFEST)}, now())
      `;
    }
    owner = await signIn(USERS.ownerSur);
    analyst = await signIn(USERS.both); // analyst in Demo Sur
    stranger = await signIn(USERS.ownerNorte);

    const created = await createContentRepository(owner.client).createDestination(
      SUR,
      `reemplazo-${randomUUID().slice(0, 8)}`,
      "Reemplazo de prueba",
    );
    if (created.status !== "created") throw new Error(`destination: ${created.status}`);
    const tours = createTourRepository(owner.client);
    const tour = await tours.create(SUR, created.contentId);
    if (tour.status !== "created") throw new Error(`tour: ${tour.status}`);
    tourId = tour.tourId;
    const edit = (await tours.find(SUR, tourId))?.draft?.editCount ?? 0;
    const scene = await tours.addScene(SUR, tourId, edit, used.version, "Sala");
    if (scene.status !== "saved" || scene.editCount === undefined) throw new Error(scene.status);
    const published = await tours.publish(SUR, tourId, scene.editCount);
    if (published.status !== "published") throw new Error(`publish: ${published.status}`);
  });

  afterAll(async () => {
    await admin.end({ timeout: 5 });
  });

  it("a new version goes to the tour's draft; visitors keep the old one", async () => {
    const membership = (await owner.reader.listActiveMemberships(owner.actor.userId)).find(
      (entry) => entry.tenantId === SUR,
    );
    if (!membership) throw new Error("no membership in Sur");
    const library = createMediaLibraryRepository(owner.client);

    expect(
      (await library.uses(SUR, "panorama")).filter((use) => use.assetId === used.asset),
    ).toEqual([expect.objectContaining({ scope: "published", working: true, version: 1 })]);

    const upload = await requestPanoramaUpload(
      membership,
      { mime: "image/jpeg", bytes: 2_000_000, replaces: used.asset },
      createMediaRepository(owner.client),
    );
    if (upload.status !== "upload") throw new Error(`upload: ${upload.status}`);
    expect(upload.uploadUrl).toContain(`${used.asset}/2/original`);
    expect(
      await requestPanoramaUpload(
        membership,
        { mime: "image/jpeg", bytes: 2_000_000, replaces: used.asset },
        createMediaRepository(owner.client),
      ),
    ).toEqual({ status: "busy" });

    // The pipeline's result, simulated.
    await admin`
      update public.asset_versions
      set status = 'ready', mime = 'image/jpeg', bytes = 2000000, width = 8192, height = 4096,
          sha256 = ${"c".repeat(64)}, ready_at = now(), manifest = ${admin.json(MANIFEST)}
      where id = ${upload.versionId}
    `;

    expect(
      await createMediaLibraryRepository(analyst.client).applyReplacement(SUR, upload.versionId),
    ).toEqual({
      status: "forbidden",
    });
    expect(
      await createMediaLibraryRepository(stranger.client).applyReplacement(SUR, upload.versionId),
    ).toEqual({
      status: "forbidden",
    });
    expect(await applyMediaReplacement(membership, upload.versionId, library)).toEqual({
      status: "applied",
      tours: 1,
      openedDrafts: 1,
    });

    const record = await createTourRepository(owner.client).find(SUR, tourId);
    expect(record?.draft?.scenes[0]?.panorama.versionId).toBe(upload.versionId);
    expect(record?.published?.scenes[0]?.panorama.versionId).toBe(used.version);
    expect(
      (await library.uses(SUR, "panorama"))
        .filter((use) => use.assetId === used.asset)
        .map((use) => [use.scope, use.version])
        .sort(),
    ).toEqual([
      ["draft", 2],
      ["published", 1],
    ]);
  });

  it("only what no tour ever used is deleted, and its files go to the cleanup", async () => {
    const membership = (await owner.reader.listActiveMemberships(owner.actor.userId)).find(
      (entry) => entry.tenantId === SUR,
    );
    if (!membership) throw new Error("no membership in Sur");
    const library = createMediaLibraryRepository(owner.client);

    expect(await deleteTourMedia(membership, used.asset, library)).toEqual({ status: "in_use" });
    expect(
      await createMediaLibraryRepository(analyst.client).deleteAsset(SUR, unused.asset),
    ).toEqual({ status: "forbidden" });
    expect(
      await createMediaLibraryRepository(stranger.client).deleteAsset(SUR, unused.asset),
    ).toEqual({ status: "forbidden" });

    expect(await deleteTourMedia(membership, unused.asset, library)).toEqual({
      status: "deleted",
    });
    const listed = await createPanoramaRepository(owner.client).list(SUR);
    expect(listed.some((view) => view.assetId === unused.asset)).toBe(false);
    expect(listed.some((view) => view.assetId === used.asset)).toBe(true);
    const [job] = await admin<{ kind: string }[]>`
      select kind from public.background_jobs
      where tenant_id = ${SUR} and logical_key = ${`deleted_version:${unused.version}`}
    `;
    expect(job?.kind).toBe("media.remove_unused");
    expect(await deleteTourMedia(membership, unused.asset, library)).toEqual({
      status: "not_found",
    });
  });
});

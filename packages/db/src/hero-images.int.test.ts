/**
 * The hero versions of the home cover (ADR-070) against a REAL local Supabase stack: a
 * photo uploaded before they existed gets them from the runner's job, in the private bucket
 * and, when it is public, in the public one; only then does the portal's image say "hero".
 */
import { randomUUID } from "node:crypto";

import { drainJobs } from "@rikuy/core";
import { createHeroImagesProcessor } from "@rikuy/worker";
import postgres from "postgres";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { env, stackAvailable } from "./integration/local-stack";
import { createPostgresJobLedger } from "./job-ledger";
import {
  createSharpImageProcessor,
  createSupabaseMediaAdmin,
  MEDIA_BUCKETS,
  publicMediaUrl,
} from "./media";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";

describe.runIf(stackAvailable)("hero versions of photos uploaded before (ADR-070)", () => {
  const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
  const admin = createSupabaseMediaAdmin({ url: env.url, secretKey: env.secretKey });
  const published = { asset: randomUUID(), version: randomUUID() };
  const draft = { asset: randomUUID(), version: randomUUID() };
  const folderOf = (asset: string) => `${SUR}/${asset}/1/`;
  const files = async (bucket: string, asset: string) =>
    (
      await db`
        select name from storage.objects
        where bucket_id = ${bucket} and name like ${`${folderOf(asset)}hero-%`} order by name
      `
    ).map((row) => String(row.name).slice(folderOf(asset).length));
  const image = async (version: string) => {
    const [row] = await db`select private.public_image(${version}::uuid, 'Foto') as image`;
    return row?.image as Record<string, unknown> | null;
  };

  beforeAll(async () => {
    if (env.secretKey === "") throw new Error("SUPABASE_SECRET_KEY is required");
    const original = new Uint8Array(
      await sharp({ create: { width: 1500, height: 1000, channels: 3, background: "#3d6b4f" } })
        .jpeg()
        .toBuffer(),
    );
    for (const media of [published, draft]) {
      await db`insert into public.assets (id, tenant_id, purpose) values (${media.asset}, ${SUR}, 'content')`;
      await db`
        insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                           mime, bytes, width, height, sha256, ready_at)
        values (${media.version}, ${SUR}, ${media.asset}, 1, 'ready', 'image/jpeg', ${original.length},
                'image/jpeg', ${original.length}, 1500, 1000, ${"d".repeat(64)}, now())
      `;
      // As before ADR-070: the original and the regular derivatives, no hero versions.
      const regular = (await createSharpImageProcessor().contentDerivatives(original)).filter(
        (file) => !file.name.startsWith("hero-"),
      );
      await admin.storeDerivatives(folderOf(media.asset), [
        { name: "original", bytes: original, contentType: "image/webp" },
        ...regular,
      ]);
    }
    await admin.publish(SUR, published.asset, 1, ["w480.webp", "w960.webp", "w1600.webp"]);
  });

  afterAll(async () => {
    await db.end({ timeout: 5 });
  });

  it("stores them, makes them public for a public photo, and only then the portal uses them", async () => {
    expect(await image(published.version)).not.toHaveProperty("hero");
    for (const media of [published, draft]) {
      await db`
        select private.enqueue_job(${SUR}::uuid, 'media.hero_images', ${`it:${media.version}`},
          jsonb_build_object('versionId', ${media.version}::uuid), 'asset_version', ${media.version}::uuid)
      `;
    }

    const ledger = createPostgresJobLedger({
      url: DB_URL,
      role: "rikuy_worker",
      maxConnections: 2,
    });
    try {
      await drainJobs({
        ledger,
        processors: [
          createHeroImagesProcessor({
            heroes: ledger.heroes,
            heroMedia: admin,
            imageProcessor: createSharpImageProcessor(),
          }),
        ],
        runnerId: "it-hero",
        budgetMs: 20_000,
      });
    } finally {
      await ledger.close();
    }

    const statuses = await db`
      select status from public.background_jobs
      where kind = 'media.hero_images' and subject_id in (${published.version}, ${draft.version})
    `;
    expect(statuses.map((row) => row.status)).toEqual(["succeeded", "succeeded"]);
    expect(await files(MEDIA_BUCKETS.originals, published.asset)).toEqual([
      "hero-w1200.webp",
      "hero-w800.webp",
    ]);
    expect(await files(MEDIA_BUCKETS.public, published.asset)).toEqual([
      "hero-w1200.webp",
      "hero-w800.webp",
    ]);
    expect((await image(published.version))?.hero).toBe(true);

    // A photo that is not public keeps them private until a publication copies them.
    expect(await files(MEDIA_BUCKETS.originals, draft.asset)).toHaveLength(2);
    expect(await files(MEDIA_BUCKETS.public, draft.asset)).toEqual([]);
    await admin.publish(
      SUR,
      draft.asset,
      1,
      ["w480.webp", "w960.webp", "w1600.webp"],
      ["hero-w800.webp", "hero-w1200.webp"],
    );
    expect(await files(MEDIA_BUCKETS.public, draft.asset)).toHaveLength(2);
    expect((await image(draft.version))?.hero).toBe(true);

    const hero = await fetch(publicMediaUrl(env.url, `${folderOf(published.asset)}hero-w800.webp`));
    expect(hero.status).toBe(200);
    expect(hero.headers.get("content-type")).toBe("image/webp");
  });
});

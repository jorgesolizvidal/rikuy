/**
 * Deleting and moving a tour (C0 · Paso 3, ADR-049) against a REAL local Supabase stack,
 * with each person's session: an analyst sees what would change but cannot move or delete,
 * another municipality's owner sees nothing, the owner moves the tour (its old page leads to
 * the new one for visitors) and deletes it (its page then leads to its place). Demo Sur only.
 */
import { randomUUID } from "node:crypto";

import { deleteTour, loadTourRemoval, moveTour } from "@rikuy/core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createContentRepository } from "./content";
import { env, signIn, stackAvailable, USERS } from "./integration/local-stack";
import {
  createSupabasePublishedTourRedirectReader,
  createTourRemovalRepository,
} from "./tour-removal";
import { createSupabasePublishedTourReader, createTourRepository } from "./tours";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const MANIFEST = {
  version: 1,
  projection: "equirectangular",
  source: { width: 4096, height: 2048, bytes: 1000, mime: "image/jpeg", sha256: "a".repeat(64) },
  preview: { file: "preview.webp", width: 256, height: 128, bytes: 1000 },
  image: { file: "image.webp", width: 512, height: 256, bytes: 2000 },
  tiles: null,
};

describe.runIf(stackAvailable)("deleting and moving a tour against local Supabase", () => {
  const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
  const panorama = { asset: randomUUID(), version: randomUUID() };
  const suffix = randomUUID().slice(0, 8);
  const places = { from: `origen-${suffix}`, to: `destino-${suffix}` };
  const ids = { from: "", to: "", tour: "" };
  let owner: Awaited<ReturnType<typeof signIn>>;
  let analyst: Awaited<ReturnType<typeof signIn>>;
  let stranger: Awaited<ReturnType<typeof signIn>>;
  const visitors = () => ({
    tours: createSupabasePublishedTourReader({ url: env.url, publishableKey: env.publishableKey }),
    redirects: createSupabasePublishedTourRedirectReader({
      url: env.url,
      publishableKey: env.publishableKey,
    }),
  });

  beforeAll(async () => {
    await db`insert into public.assets (id, tenant_id, purpose) values (${panorama.asset}, ${SUR}, 'panorama')`;
    await db`
      insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                         mime, bytes, width, height, sha256, ready_at, manifest, published_at)
      values (${panorama.version}, ${SUR}, ${panorama.asset}, 1, 'ready', 'image/jpeg', 1000, 'image/jpeg', 1000,
              4096, 2048, ${"e".repeat(64)}, now(), ${db.json(MANIFEST)}, now())
    `;
    owner = await signIn(USERS.ownerSur);
    analyst = await signIn(USERS.both); // analyst in Demo Sur
    stranger = await signIn(USERS.ownerNorte);

    const content = createContentRepository(owner.client);
    for (const [key, slug] of Object.entries(places) as ["from" | "to", string][]) {
      const created = await content.createDestination(SUR, slug, `Lugar ${slug}`);
      if (created.status !== "created") throw new Error(created.status);
      const saved = await content.saveDraft(
        SUR,
        created.contentId,
        {
          title: `Lugar ${slug}`,
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
      ids[key] = created.contentId;
    }
    const tours = createTourRepository(owner.client);
    const tour = await tours.create(SUR, ids.from);
    if (tour.status !== "created") throw new Error(tour.status);
    ids.tour = tour.tourId;
    const scene = await tours.addScene(SUR, tour.tourId, 1, panorama.version, "Sala");
    if (scene.status !== "saved" || scene.editCount === undefined) throw new Error(scene.status);
    const published = await tours.publish(SUR, tour.tourId, scene.editCount);
    if (published.status !== "published") throw new Error(published.status);
  });

  afterAll(async () => {
    await db.end({ timeout: 5 });
  });

  async function membershipOf(session: Awaited<ReturnType<typeof signIn>>) {
    const membership = (await session.reader.listActiveMemberships(session.actor.userId)).find(
      (entry) => entry.tenantId === SUR,
    );
    if (!membership) throw new Error("no membership in Demo Sur");
    return membership;
  }

  it("an analyst sees what would change but moves and deletes nothing", async () => {
    const membership = await membershipOf(analyst);
    const removal = createTourRemovalRepository(analyst.client);
    const loaded = await loadTourRemoval(membership, ids.tour, {
      removal,
      tours: createTourRepository(analyst.client),
      candidates: async () => [],
    });
    expect(loaded).toMatchObject({
      impact: { contentId: ids.from, revisions: 1, published: true, linkedFrom: [] },
      canRemove: false,
    });
    // Straight to the database, past the use case's role check.
    expect(await removal.moveTour(SUR, ids.tour, ids.to)).toEqual({ status: "forbidden" });
    expect(await removal.deleteTour(SUR, ids.tour)).toEqual({ status: "forbidden" });
  });

  it("another municipality's owner sees nothing and changes nothing", async () => {
    const removal = createTourRemovalRepository(stranger.client);
    expect(await removal.removalImpact(SUR, ids.tour)).toBeNull();
    expect(await removal.moveTour(SUR, ids.tour, ids.to)).toEqual({ status: "forbidden" });
    expect(await removal.deleteTour(SUR, ids.tour)).toEqual({ status: "forbidden" });
  });

  it("the owner moves the tour: its old page leads to the new one", async () => {
    const membership = await membershipOf(owner);
    const removal = createTourRemovalRepository(owner.client);
    expect(await moveTour(membership, { tourId: ids.tour, contentId: ids.from }, removal)).toEqual({
      status: "same",
    });
    expect(await moveTour(membership, { tourId: ids.tour, contentId: ids.to }, removal)).toEqual({
      status: "moved",
      from: { kind: "destination", slug: places.from },
      to: { kind: "destination", slug: places.to },
      formerPlaces: [],
    });

    const { tours, redirects } = visitors();
    expect(await tours.find(SUR, "destination", places.to)).not.toBeNull();
    expect(await tours.find(SUR, "destination", places.from)).toBeNull();
    expect(await redirects.find(SUR, "destination", places.from)).toEqual({
      kind: "destination",
      slug: places.to,
      target: "tour",
    });
    expect(await redirects.find(SUR, "destination", places.to)).toBeNull();
  });

  it("the owner deletes it: its page leads to its place, and nothing of it is left", async () => {
    const membership = await membershipOf(owner);
    expect(
      await deleteTour(membership, ids.tour, createTourRemovalRepository(owner.client)),
    ).toEqual({
      status: "deleted",
      place: { kind: "destination", slug: places.to },
      formerPlaces: [{ kind: "destination", slug: places.from }],
    });

    const { tours, redirects } = visitors();
    expect(await tours.find(SUR, "destination", places.to)).toBeNull();
    expect(await redirects.find(SUR, "destination", places.to)).toEqual({
      kind: "destination",
      slug: places.to,
      target: "place",
    });
    expect(await redirects.find(SUR, "destination", places.from)).toEqual({
      kind: "destination",
      slug: places.from,
      target: "place",
    });
    const [left] = await db<{ revisions: number }[]>`
      select count(*)::int as revisions from public.tour_revisions where tour_id = ${ids.tour}`;
    expect(left?.revisions).toBe(0);
    expect(await createTourRepository(owner.client).find(SUR, ids.tour)).toBeNull();
  });
});

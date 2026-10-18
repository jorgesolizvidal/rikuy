/**
 * Destinations against a REAL local Supabase stack: an editor writes a draft with a photo
 * uploaded straight to Storage, an owner publishes it, edits do not reach visitors until
 * published, and rolling back restores the previous revision without touching anything
 * else. Isolation is checked with the other tenant's owner and anonymous reads.
 */
import {
  confirmContentImageUpload,
  contentImagePath,
  createDestination,
  loadDestinationEditor,
  publishDestination,
  requestContentImageUpload,
  restoreDestinationRevision,
  saveDestinationDraft,
  type DestinationDocument,
  type OrganizationMembership,
} from "@rikuy/core";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { createContentRepository, createSupabasePublishedContentReader } from "./content";
import { env, signIn, stackAvailable, USERS } from "./integration/local-stack";
import {
  createMediaRepository,
  createSharpImageProcessor,
  createSupabaseMediaAdmin,
  publicMediaUrl,
} from "./media";

const NORTE = "5eed1000-0000-4000-8000-000000000001";
const SUR = "5eed1000-0000-4000-8000-000000000002";

async function membershipOf(session: Awaited<ReturnType<typeof signIn>>, tenantId: string) {
  const memberships = await session.reader.listActiveMemberships(session.actor.userId);
  const membership = memberships.find((m) => m.tenantId === tenantId);
  if (!membership) throw new Error(`no membership in ${tenantId}`);
  return membership;
}

describe.runIf(stackAvailable)("destinations against local Supabase", () => {
  let editor: Awaited<ReturnType<typeof signIn>>;
  let owner: Awaited<ReturnType<typeof signIn>>;
  let editorNorte: OrganizationMembership;
  let ownerNorte: OrganizationMembership;
  let admin: ReturnType<typeof createSupabaseMediaAdmin>;
  const visitors = () =>
    createSupabasePublishedContentReader({ url: env.url, publishableKey: env.publishableKey });

  beforeAll(async () => {
    if (env.secretKey === "") throw new Error("SUPABASE_SECRET_KEY is required");
    editor = await signIn(USERS.both); // editor in Demo Norte
    owner = await signIn(USERS.ownerNorte);
    editorNorte = await membershipOf(editor, NORTE);
    ownerNorte = await membershipOf(owner, NORTE);
    admin = createSupabaseMediaAdmin({ url: env.url, secretKey: env.secretKey });
  });

  it("draft → publish → edit → publish → roll back, visible only when published", async () => {
    const editorContent = createContentRepository(editor.client);
    const ownerContent = createContentRepository(owner.client);
    const slug = `integracion-${Date.now()}`;

    const created = await createDestination(
      editorNorte,
      { title: "Plaza de integración", slug },
      editorContent,
    );
    if (created.status !== "created") throw new Error(`create: ${created.status}`);
    const { contentId } = created;

    // The editor uploads a photo directly to Storage; the server validates the bytes.
    const photo = new Uint8Array(
      await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#3d6b4f" } })
        .jpeg()
        .toBuffer(),
    );
    const media = createMediaRepository(editor.client);
    const upload = await requestContentImageUpload(
      editorNorte,
      { mime: "image/jpeg", bytes: photo.length },
      media,
    );
    if (upload.status !== "upload") throw new Error(`upload: ${upload.status}`);
    const sent = await fetch(upload.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: photo,
    });
    expect(sent.ok).toBe(true);
    const ready = await confirmContentImageUpload(editorNorte, upload.versionId, {
      media,
      admin,
      processor: createSharpImageProcessor(),
    });
    if (ready.status !== "ready") throw new Error(`confirm: ${ready.status}`);

    const first: DestinationDocument = {
      title: "Plaza de integración",
      summary: "Una plaza para probar la publicación.",
      body: [{ type: "paragraph", children: [{ type: "text", text: "Primera versión." }] }],
      location: { lat: -17.4, lng: -66.1 },
      cover: { ...ready.image, alt: "La plaza vista desde la esquina" },
      gallery: [],
    };
    const editorView = await loadDestinationEditor(editorNorte, contentId, editorContent);
    const saved = await saveDestinationDraft(
      editorNorte,
      contentId,
      first,
      editorView?.editCount ?? null,
      editorContent,
    );
    if (saved.status !== "saved") throw new Error(`save: ${saved.status}`);

    // Editors cannot publish; visitors see nothing yet.
    expect(
      await publishDestination(
        editorNorte,
        contentId,
        first,
        saved.editCount,
        editorContent,
        admin,
      ),
    ).toEqual({
      status: "forbidden",
    });
    expect(await visitors().find(NORTE, slug)).toBeNull();
    const before = await visitors().list(NORTE);

    // The owner publishes: the photo's derivatives become public, then the revision.
    expect(
      await publishDestination(ownerNorte, contentId, first, saved.editCount, ownerContent, admin),
    ).toEqual({
      status: "published",
      revisionNo: 1,
    });
    const v1 = await visitors().find(NORTE, slug);
    expect(v1?.summary).toBe("Una plaza para probar la publicación.");
    expect(v1?.cover?.alt).toBe("La plaza vista desde la esquina");
    const image = await fetch(
      publicMediaUrl(env.url, contentImagePath(NORTE, ready.image, "w960.webp")),
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/webp");

    // A new draft does not reach visitors until it is published.
    const second = { ...first, summary: "Segunda versión, con más detalle.", cover: null };
    const draft2 = await saveDestinationDraft(editorNorte, contentId, second, null, editorContent);
    if (draft2.status !== "saved") throw new Error(`save 2: ${draft2.status}`);
    expect((await visitors().find(NORTE, slug))?.summary).toBe(
      "Una plaza para probar la publicación.",
    );
    expect(
      await publishDestination(
        ownerNorte,
        contentId,
        second,
        draft2.editCount,
        ownerContent,
        admin,
      ),
    ).toEqual({
      status: "published",
      revisionNo: 2,
    });
    expect((await visitors().find(NORTE, slug))?.summary).toBe("Segunda versión, con más detalle.");

    // Roll back to revision 1: only this destination changes.
    const record = await ownerContent.findDestination(NORTE, contentId);
    const revision1 = record?.history.find((entry) => entry.revisionNo === 1);
    if (!revision1) throw new Error("revision 1 missing from the history");
    expect(
      await restoreDestinationRevision(editorNorte, contentId, revision1.revisionId, editorContent),
    ).toEqual({
      status: "forbidden",
    });
    expect(
      await restoreDestinationRevision(ownerNorte, contentId, revision1.revisionId, ownerContent),
    ).toEqual({
      status: "restored",
      revisionNo: 1,
    });
    expect((await visitors().find(NORTE, slug))?.summary).toBe(
      "Una plaza para probar la publicación.",
    );
    const after = await visitors().list(NORTE);
    expect(after.filter((entry) => entry.slug !== slug)).toEqual(before);

    // Another municipality sees nothing of it, and the same slug in Sur does not exist.
    const sur = await signIn(USERS.ownerSur);
    expect(await createContentRepository(sur.client).findDestination(NORTE, contentId)).toBeNull();
    expect(await visitors().find(SUR, slug)).toBeNull();
  });

  it("the database rejects drafts that point at another tenant's image", async () => {
    const sur = await signIn(USERS.ownerSur);
    const surContent = createContentRepository(sur.client);
    const surMembership = await membershipOf(sur, SUR);
    const created = await createDestination(
      surMembership,
      { title: "Prueba aislamiento", slug: `aislamiento-${Date.now()}` },
      surContent,
    );
    if (created.status !== "created") throw new Error(`create: ${created.status}`);
    // A Norte image id, valid in shape but not Sur's.
    const norteImages = await editor.client
      .from("asset_versions")
      .select("asset_id, version")
      .eq("tenant_id", NORTE)
      .limit(1);
    const foreign = norteImages.data?.[0] as { asset_id: string; version: number } | undefined;
    if (!foreign) throw new Error("no Norte image to reference");
    expect(
      await saveDestinationDraft(
        surMembership,
        created.contentId,
        {
          title: "Prueba aislamiento",
          summary: "",
          body: [],
          location: null,
          cover: { assetId: foreign.asset_id, version: foreign.version, alt: "Ajena" },
          gallery: [],
        },
        1,
        surContent,
      ),
    ).toEqual({ status: "invalid", issues: [{ path: "images", code: "media" }] });
  });
});

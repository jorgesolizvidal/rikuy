/**
 * Tenant media against a REAL local Supabase stack (Storage included): the owner obtains a
 * signed upload URL, the browser-equivalent PUT sends the bytes straight to Storage, the
 * server validates them and publishes the brand with its logo. Isolation is checked with
 * the other tenant's owner and with anonymous requests.
 */
import {
  confirmLogoUpload,
  publishBranding,
  publishedLogoPath,
  requestLogoUpload,
  type OrganizationMembership,
  type TenantPresentation,
} from "@rikuy/core";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { signIn, stackAvailable, env, USERS } from "./integration/local-stack";
import {
  createMediaRepository,
  createSharpImageProcessor,
  createSupabaseMediaAdmin,
  MEDIA_BUCKETS,
  publicMediaUrl,
} from "./media";

const NORTE = "5eed1000-0000-4000-8000-000000000001";

async function logoPng(): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320">
    <rect width="640" height="320" fill="#1f6f4a"/><circle cx="160" cy="160" r="110" fill="#f7f8f6"/></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}

async function put(url: string, bytes: Uint8Array, contentType: string) {
  return fetch(url, { method: "PUT", headers: { "content-type": contentType }, body: bytes });
}

describe.runIf(stackAvailable)("tenant media against local Supabase", () => {
  let owner: Awaited<ReturnType<typeof signIn>>;
  let membership: OrganizationMembership;
  let deps: {
    media: ReturnType<typeof createMediaRepository>;
    admin: ReturnType<typeof createSupabaseMediaAdmin>;
    processor: ReturnType<typeof createSharpImageProcessor>;
  };

  beforeAll(async () => {
    if (env.secretKey === "") throw new Error("SUPABASE_SECRET_KEY is required");
    owner = await signIn(USERS.ownerNorte);
    const [first] = await owner.reader.listActiveMemberships(owner.actor.userId);
    if (!first) throw new Error("owner has no membership");
    membership = first;
    deps = {
      media: createMediaRepository(owner.client),
      admin: createSupabaseMediaAdmin({ url: env.url, secretKey: env.secretKey }),
      processor: createSharpImageProcessor(),
    };
  });

  it("uploads, validates and publishes a logo; only derivatives become public", async () => {
    const bytes = await logoPng();
    const request = await requestLogoUpload(
      membership,
      { mime: "image/png", bytes: bytes.length },
      deps.media,
    );
    if (request.status !== "upload") throw new Error(`upload refused: ${request.status}`);

    // Confirming before the bytes arrive changes nothing.
    expect(await confirmLogoUpload(membership, request.versionId, deps)).toEqual({
      status: "not_uploaded",
    });

    expect((await put(request.uploadUrl, bytes, "image/png")).ok).toBe(true);
    // A signed upload URL works once: the original is immutable.
    expect((await put(request.uploadUrl, bytes, "image/png")).ok).toBe(false);

    const ready = await confirmLogoUpload(membership, request.versionId, deps);
    if (ready.status !== "ready") throw new Error(`confirm failed: ${ready.status}`);
    expect(ready.previewUrl).toContain("/object/sign/media-originals/");
    expect((await fetch(ready.previewUrl ?? "")).status).toBe(200);

    const webpPath = publishedLogoPath(NORTE, ready.logo, "logo.webp");
    // Not public until the brand that uses it is published.
    expect((await fetch(publicMediaUrl(env.url, webpPath))).ok).toBe(false);

    const snapshot = await owner.config.loadSnapshot(NORTE);
    const before = snapshot.published?.presentation as TenantPresentation;
    const withLogo: TenantPresentation = { ...before, logo: ready.logo };
    const published = await publishBranding(
      membership,
      withLogo,
      snapshot.draft?.revision ?? null,
      owner.config,
      deps.admin,
    );
    try {
      expect(published.status).toBe("published");
      for (const [file, type] of [
        ["logo.webp", "image/webp"],
        ["logo.png", "image/png"],
      ] as const) {
        const response = await fetch(
          publicMediaUrl(env.url, publishedLogoPath(NORTE, ready.logo, file)),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(type);
        const info = await sharp(new Uint8Array(await response.arrayBuffer())).metadata();
        expect([info.width, info.height]).toEqual([512, 256]);
      }
      // The original never reaches the public bucket, and anonymous visitors cannot read it.
      const originalPath = `${NORTE}/${ready.logo.assetId}/${ready.logo.version}/original`;
      expect((await fetch(publicMediaUrl(env.url, originalPath))).ok).toBe(false);
      expect(
        (
          await fetch(
            `${env.url}/storage/v1/object/public/${MEDIA_BUCKETS.originals}/${originalPath}`,
          )
        ).ok,
      ).toBe(false);

      // The owner of another municipality cannot read the original nor upload for Norte.
      const sur = await signIn(USERS.ownerSur);
      const download = await sur.client.storage
        .from(MEDIA_BUCKETS.originals)
        .download(originalPath);
      expect(download.data).toBeNull();
      expect(
        await requestLogoUpload(
          { ...membership },
          { mime: "image/png", bytes: 100 },
          createMediaRepository(sur.client),
        ),
      ).toEqual({ status: "forbidden" });
      // Nor write directly into Norte's folder with their own session.
      const forged = await sur.client.storage
        .from(MEDIA_BUCKETS.originals)
        .upload(`${NORTE}/${ready.logo.assetId}/99/original`, bytes, { contentType: "image/png" });
      expect(forged.error).not.toBeNull();
    } finally {
      const restored = await publishBranding(membership, before, null, owner.config, deps.admin);
      expect(restored.status).toBe("published");
    }
  });

  it("rejects bytes that are not what was declared and deletes them", async () => {
    const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    const request = await requestLogoUpload(
      membership,
      { mime: "image/png", bytes: html.length },
      deps.media,
    );
    if (request.status !== "upload") throw new Error(`upload refused: ${request.status}`);
    // Storage itself refuses a content type outside the bucket's allow-list…
    expect((await put(request.uploadUrl, html, "text/html")).ok).toBe(false);
    // …so an attacker lies about it; the server inspects the real bytes.
    expect((await put(request.uploadUrl, html, "image/png")).ok).toBe(true);
    expect(await confirmLogoUpload(membership, request.versionId, deps)).toEqual({
      status: "rejected",
      problem: "unreadable",
    });
    const version = await deps.media.findVersion(request.versionId);
    expect(version?.status).toBe("rejected");
    if (version) expect(await deps.admin.readOriginal(version.originalPath)).toBeNull();
  });

  it("editors may not change the logo", async () => {
    const both = await signIn(USERS.both); // editor in Demo Norte
    const [editorMembership] = (await both.reader.listActiveMemberships(both.actor.userId)).filter(
      (m) => m.tenantId === NORTE,
    );
    if (!editorMembership) throw new Error("editor has no Norte membership");
    // The use case refuses, and so does the database if the check were skipped.
    expect(
      await requestLogoUpload(
        editorMembership,
        { mime: "image/png", bytes: 100 },
        createMediaRepository(both.client),
      ),
    ).toEqual({ status: "forbidden" });
    expect(
      await createMediaRepository(both.client).createImageUpload(NORTE, "logo", "image/png", 100),
    ).toEqual({ status: "forbidden" });
  });

  // Runs last and only in CI: leaves Demo Norte with a published logo so the portal e2e
  // (`portals.e2e.mjs --logo`) checks the header, og:image and icons with a real one.
  it.runIf(Boolean(process.env.CI))("leaves a published logo for the portal e2e", async () => {
    const bytes = await logoPng();
    const request = await requestLogoUpload(
      membership,
      { mime: "image/png", bytes: bytes.length },
      deps.media,
    );
    if (request.status !== "upload") throw new Error(`upload refused: ${request.status}`);
    expect((await put(request.uploadUrl, bytes, "image/png")).ok).toBe(true);
    const ready = await confirmLogoUpload(membership, request.versionId, deps);
    if (ready.status !== "ready") throw new Error(`confirm failed: ${ready.status}`);
    const snapshot = await owner.config.loadSnapshot(NORTE);
    const current = snapshot.published?.presentation as TenantPresentation;
    const published = await publishBranding(
      membership,
      { ...current, logo: ready.logo },
      snapshot.draft?.revision ?? null,
      owner.config,
      deps.admin,
    );
    expect(published.status).toBe("published");
  });
});

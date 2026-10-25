import { createClient, type PostgrestError } from "@supabase/supabase-js";
import {
  CONTENT_IMAGE_WIDTHS,
  type CreateUploadOutcome,
  type DerivedFile,
  type ImageProcessor,
  type ImageVersionRecord,
  type MediaAdmin,
  type OriginalRemover,
  type MediaRepository,
} from "@rikuy/core";
import sharp from "sharp";
import { z } from "zod";

import type { SessionClient } from "./session-client";

/**
 * Media adapters (migration 20261018100000).
 *
 * - `createMediaRepository`: the signed-in user's session. Storage RLS lets people write
 *   only the original of a version they may upload, and read originals of their tenants.
 * - `createSupabaseMediaAdmin`: the isolated writer of derivatives and of the public
 *   bucket (secret key). Called only after a use case authorized the request.
 * - `createSharpImageProcessor`: re-encodes images; metadata (EXIF, GPS) is dropped.
 */

export const MEDIA_BUCKETS = { originals: "media-originals", public: "media-public" } as const;

/** Upload originals and derivatives are capped well below the bucket limit. */
// The largest original any purpose accepts (panoramas: 50 MB; per-purpose rules check the rest).
const MAX_ORIGINAL_BYTES = 50 * 1024 * 1024;
const PREVIEW_SECONDS = 600;

function unexpected(
  operation: string,
  error: { code?: string | undefined; message?: string },
): Error {
  return new Error(`${operation} failed (${error.code || "unknown"})`);
}

/** Public URL of a file in media-public (immutable: the path contains the version). */
export function publicMediaUrl(supabaseUrl: string, path: string): string {
  return `${supabaseUrl.replace(/\/+$/u, "")}/storage/v1/object/public/${MEDIA_BUCKETS.public}/${path}`;
}

const versionRowSchema = z.object({
  id: z.uuid(),
  tenant_id: z.uuid(),
  asset_id: z.uuid(),
  version: z.number().int(),
  status: z.enum(["uploading", "processing", "ready", "rejected"]),
  declared_mime: z.string(),
  original_path: z.string(),
});

export function createMediaRepository(client: SessionClient): MediaRepository {
  return {
    async createImageUpload(tenantId, purpose, mime, bytes): Promise<CreateUploadOutcome> {
      const { data, error } = await client.rpc("create_image_upload", {
        p_tenant_id: tenantId,
        p_purpose: purpose,
        p_mime: mime,
        p_bytes: bytes,
      });
      if (error) {
        const code = (error as PostgrestError).code;
        if (code === "42501") return { status: "forbidden" };
        if (code === "23514") return { status: "invalid" };
        if (code === "PT429") return { status: "rate_limited" };
        if (code === "PT507") {
          const hint = (error as PostgrestError).hint;
          return {
            status: "over_quota",
            resource: hint === "media_compute_seconds" ? "media_compute_seconds" : "storage_bytes",
          };
        }
        throw unexpected("Starting the upload", error);
      }
      const [row] = z
        .array(
          z.object({
            asset_id: z.uuid(),
            version_id: z.uuid(),
            version: z.number().int(),
            original_path: z.string(),
          }),
        )
        .length(1)
        .parse(data);
      if (!row) throw new Error("Starting the upload returned no row");
      return {
        status: "created",
        upload: {
          assetId: row.asset_id,
          versionId: row.version_id,
          version: row.version,
          originalPath: row.original_path,
        },
      };
    },

    async signedUploadUrl(originalPath) {
      const { data, error } = await client.storage
        .from(MEDIA_BUCKETS.originals)
        .createSignedUploadUrl(originalPath);
      if (error || !data) throw unexpected("Signing the upload", error ?? {});
      return data.signedUrl;
    },

    async findVersion(versionId): Promise<ImageVersionRecord | null> {
      const version = await client
        .from("asset_versions")
        .select("id, tenant_id, asset_id, version, status, declared_mime, original_path")
        .eq("id", versionId)
        .maybeSingle();
      if (version.error) throw unexpected("Reading the image version", version.error);
      if (version.data === null) return null;
      const row = versionRowSchema.parse(version.data);

      const asset = await client
        .from("assets")
        .select("purpose")
        .eq("id", row.asset_id)
        .maybeSingle();
      if (asset.error) throw unexpected("Reading the image", asset.error);
      if (asset.data === null) return null;
      const { purpose } = z
        .object({ purpose: z.enum(["logo", "content", "panorama", "model"]) })
        .parse(asset.data);

      return {
        versionId: row.id,
        tenantId: row.tenant_id,
        assetId: row.asset_id,
        version: row.version,
        purpose,
        status: row.status,
        declaredMime: row.declared_mime,
        originalPath: row.original_path,
      };
    },

    async signedPreviewUrl(path) {
      const { data, error } = await client.storage
        .from(MEDIA_BUCKETS.originals)
        .createSignedUrl(path, PREVIEW_SECONDS);
      return error || !data ? null : data.signedUrl;
    },

    async signedPreviewUrls(paths) {
      const unique = [...new Set(paths)];
      if (unique.length === 0) return new Map();
      const { data, error } = await client.storage
        .from(MEDIA_BUCKETS.originals)
        .createSignedUrls(unique, PREVIEW_SECONDS);
      if (error || !data) return new Map();
      return new Map(
        data.flatMap((entry) =>
          entry.path && entry.signedUrl && !entry.error
            ? [[entry.path, entry.signedUrl] as const]
            : [],
        ),
      );
    },
  };
}

export interface MediaAdminOptions {
  readonly url: string;
  /** SUPABASE_SECRET_KEY. Server only. */
  readonly secretKey: string;
  readonly fetch?: typeof fetch;
}

export function createSupabaseMediaAdmin(options: MediaAdminOptions): MediaAdmin & OriginalRemover {
  const admin = createClient(options.url, options.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  const originals = () => admin.storage.from(MEDIA_BUCKETS.originals);

  return {
    async readOriginal(originalPath) {
      const { data, error } = await originals().download(originalPath);
      if (error || !data) return null; // not uploaded (yet)
      if (data.size > MAX_ORIGINAL_BYTES) return null;
      return new Uint8Array(await data.arrayBuffer());
    },

    async storeDerivatives(prefix, files: readonly DerivedFile[]) {
      // A few at a time: a large panorama has hundreds of tiles.
      for (let start = 0; start < files.length; start += 8) {
        await Promise.all(
          files.slice(start, start + 8).map(async (file) => {
            const { error } = await originals().upload(`${prefix}${file.name}`, file.bytes, {
              contentType: file.contentType,
              upsert: true,
            });
            if (error) throw unexpected(`Storing ${file.name}`, error);
          }),
        );
      }
    },

    async complete(versionId, metadata) {
      const { error } = await admin.rpc("media_complete_upload", {
        p_version_id: versionId,
        p_mime: metadata.mime,
        p_bytes: metadata.bytes,
        p_width: metadata.width,
        p_height: metadata.height,
        p_sha256: metadata.sha256,
      });
      if (error) throw unexpected("Completing the upload", error);
    },

    async reject(versionId, reason, originalPath) {
      const { error } = await admin.rpc("media_reject_upload", {
        p_version_id: versionId,
        p_reason: reason,
      });
      if (error) throw unexpected("Rejecting the upload", error);
      await originals().remove([originalPath]);
    },

    async removeOriginal(originalPath) {
      const { error } = await originals().remove([originalPath]);
      if (error) throw new Error(`Removing an original failed (${error.name || "unknown"})`);
    },

    async publish(tenantId, assetId, version, files) {
      // The database checks the version is ready and belongs to the tenant (idempotent).
      const { error } = await admin.rpc("media_publish_version", {
        p_tenant_id: tenantId,
        p_asset_id: assetId,
        p_version: version,
      });
      if (error) throw unexpected("Publishing the image", error);

      const prefix = `${tenantId}/${assetId}/${version}/`;
      for (const name of files) {
        const source = await originals().download(`${prefix}${name}`);
        if (source.error || !source.data) throw unexpected(`Reading ${name}`, source.error ?? {});
        const { error: uploadError } = await admin.storage
          .from(MEDIA_BUCKETS.public)
          .upload(`${prefix}${name}`, source.data, {
            contentType: name.endsWith(".png") ? "image/png" : "image/webp",
            upsert: true,
            // Versioned path: the content never changes, so caches may keep it forever.
            cacheControl: "31536000",
          });
        if (uploadError) throw unexpected(`Publishing ${name}`, uploadError);
      }
    },
  };
}

/** Logo derivatives: at most 512 px, WebP for pages and PNG for app icons. */
export function createSharpImageProcessor(): ImageProcessor {
  return {
    async contentDerivatives(original) {
      // Photos up to 8192 px per side (CONTENT_IMAGE_RULES); EXIF orientation applied, then
      // every derivative is re-encoded without metadata (no GPS of the photographer).
      const base = sharp(original, { failOn: "error", limitInputPixels: 8192 * 8192 }).rotate();
      return Promise.all(
        CONTENT_IMAGE_WIDTHS.map(async (width) => ({
          name: `w${width}.webp`,
          contentType: "image/webp" as const,
          bytes: new Uint8Array(
            await base
              .clone()
              .resize({ width, withoutEnlargement: true })
              .webp({ quality: 80, effort: 4 })
              .toBuffer(),
          ),
        })),
      );
    },

    async logoDerivatives(original) {
      // failOn: reject truncated or corrupt files; limitInputPixels: no decompression bombs.
      const base = sharp(original, { failOn: "error", limitInputPixels: 4096 * 4096 })
        .rotate()
        .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true });
      const [webp, png] = await Promise.all([
        base.clone().webp({ quality: 90, alphaQuality: 100 }).toBuffer(),
        base.clone().png({ compressionLevel: 9 }).toBuffer(),
      ]);
      return [
        { name: "logo.webp", contentType: "image/webp", bytes: new Uint8Array(webp) },
        { name: "logo.png", contentType: "image/png", bytes: new Uint8Array(png) },
      ];
    },

    async modelPoster(captured) {
      // The panel's canvas capture: re-encoded (never stored as sent), at most 1280 px wide.
      const { data, info } = await sharp(captured, {
        failOn: "error",
        limitInputPixels: 4096 * 4096,
      })
        .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82, alphaQuality: 90, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      return {
        file: { name: "poster.webp", contentType: "image/webp", bytes: new Uint8Array(data) },
        width: info.width,
        height: info.height,
      };
    },
  };
}

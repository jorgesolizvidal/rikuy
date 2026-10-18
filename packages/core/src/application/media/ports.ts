import type { ImageMime } from "../../domain/media/image";

export type AssetPurpose = "logo" | "content";

export interface PendingUpload {
  readonly assetId: string;
  readonly versionId: string;
  readonly version: number;
  /** Path in the private originals bucket: {tenant}/{asset}/{version}/original. */
  readonly originalPath: string;
}

export type CreateUploadOutcome =
  | { readonly status: "created"; readonly upload: PendingUpload }
  | { readonly status: "forbidden" }
  | { readonly status: "invalid" }
  | { readonly status: "rate_limited" };

export interface ImageVersionRecord {
  readonly versionId: string;
  readonly tenantId: string;
  readonly assetId: string;
  readonly version: number;
  readonly purpose: AssetPurpose;
  readonly status: "uploading" | "ready" | "rejected";
  readonly declaredMime: string;
  readonly originalPath: string;
}

/** Media operations with the signed-in user's session (Storage and table RLS apply). */
export interface MediaRepository {
  createImageUpload(
    tenantId: string,
    purpose: AssetPurpose,
    mime: ImageMime,
    bytes: number,
  ): Promise<CreateUploadOutcome>;
  /** One-time URL the browser PUTs the original to. The bytes never pass through the BFF. */
  signedUploadUrl(originalPath: string): Promise<string>;
  /** Only versions the user can see (members of the tenant), else null. */
  findVersion(versionId: string): Promise<ImageVersionRecord | null>;
  /** Short-lived URL to preview a (not yet public) derivative. */
  signedPreviewUrl(path: string): Promise<string | null>;
}

export interface DerivedFile {
  readonly name: string;
  readonly contentType: "image/webp" | "image/png";
  readonly bytes: Uint8Array;
}

export interface ReadyImageMetadata {
  readonly mime: ImageMime;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

/**
 * Isolated media administration (service role, server only). The only writer of
 * derivatives and of the public bucket; called only after a use case authorized the user.
 */
export interface MediaAdmin {
  readOriginal(originalPath: string): Promise<Uint8Array | null>;
  storeDerivatives(prefix: string, files: readonly DerivedFile[]): Promise<void>;
  complete(versionId: string, metadata: ReadyImageMetadata): Promise<void>;
  reject(versionId: string, reason: string, originalPath: string): Promise<void>;
  /** Copies derivatives to the public bucket and marks the version as published. */
  publish(
    tenantId: string,
    assetId: string,
    version: number,
    files: readonly string[],
  ): Promise<void>;
}

/** Re-encodes an image into safe, metadata-free derivatives. Throws on undecodable input. */
export interface ImageProcessor {
  logoDerivatives(original: Uint8Array): Promise<DerivedFile[]>;
}

/** {tenant}/{asset}/{version}/ — prefix shared by the original and its derivatives. */
export function imageVersionPrefix(tenantId: string, assetId: string, version: number): string {
  return `${tenantId}/${assetId}/${version}/`;
}

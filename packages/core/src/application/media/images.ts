import type { UsageResource } from "../../contracts/usage";
import type { MembershipRole, OrganizationMembership } from "../../contracts/organization";
import { inspectImage } from "../../domain/media/image";
import {
  checkDeclaredImage,
  checkUploadedImage,
  type ImageProblem,
  type ImageRules,
} from "../../domain/media/rules";
import {
  imageVersionPrefix,
  type AssetPurpose,
  type DerivedFile,
  type ImageProcessor,
  type MediaAdmin,
  type MediaRepository,
} from "./ports";

/** How one kind of image is uploaded, validated and derived. */
export interface ImageProfile {
  readonly purpose: AssetPurpose;
  readonly rules: ImageRules;
  readonly uploaders: readonly MembershipRole[];
  /** Derivative shown in the editor while the image is not public yet. */
  readonly previewFile: string;
  derive(processor: ImageProcessor, original: Uint8Array): Promise<DerivedFile[]>;
}

export interface ImageVersionReference {
  readonly assetId: string;
  readonly version: number;
}

export type RequestImageUploadResult =
  | {
      readonly status: "upload";
      readonly versionId: string;
      readonly uploadUrl: string;
      readonly mime: string;
    }
  | { readonly status: "invalid"; readonly problem: ImageProblem }
  | { readonly status: "forbidden" | "rate_limited" }
  | { readonly status: "over_quota"; readonly resource: UsageResource };

/**
 * Step 1: reserve an image version and hand the browser a one-time upload URL. Only the
 * declared type and size are checked here; the real bytes are checked on confirmation.
 */
export async function requestImageUpload(
  membership: OrganizationMembership,
  profile: ImageProfile,
  input: { readonly mime: unknown; readonly bytes: unknown },
  media: MediaRepository,
): Promise<RequestImageUploadResult> {
  if (!profile.uploaders.includes(membership.role)) return { status: "forbidden" };
  const problem = checkDeclaredImage(profile.rules, input.mime, input.bytes);
  if (problem !== null) return { status: "invalid", problem };

  const mime = input.mime as "image/png" | "image/jpeg" | "image/webp";
  const created = await media.createImageUpload(
    membership.tenantId,
    profile.purpose,
    mime,
    input.bytes as number,
  );
  if (created.status === "invalid") return { status: "invalid", problem: "unreadable" };
  if (created.status === "over_quota") return created;
  if (created.status !== "created") return { status: created.status };

  return {
    status: "upload",
    versionId: created.upload.versionId,
    uploadUrl: await media.signedUploadUrl(created.upload.originalPath),
    mime,
  };
}

export type ConfirmImageUploadResult =
  | {
      readonly status: "ready";
      readonly image: ImageVersionReference;
      readonly previewUrl: string | null;
    }
  | { readonly status: "rejected"; readonly problem: ImageProblem }
  | { readonly status: "not_uploaded" | "not_found" | "forbidden" };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Step 2: after the browser uploaded, validate the REAL bytes (type by signature, weight,
 * dimensions), produce metadata-free derivatives and mark the version ready. Anything
 * that fails is rejected and its original deleted.
 */
export async function confirmImageUpload(
  membership: OrganizationMembership,
  profile: ImageProfile,
  versionId: unknown,
  deps: {
    readonly media: MediaRepository;
    readonly admin: MediaAdmin;
    readonly processor: ImageProcessor;
  },
): Promise<ConfirmImageUploadResult> {
  if (!profile.uploaders.includes(membership.role)) return { status: "forbidden" };
  if (typeof versionId !== "string" || versionId === "") return { status: "not_found" };

  // Read with the user's own session: RLS hides versions of other tenants.
  const version = await deps.media.findVersion(versionId);
  if (
    version === null ||
    version.tenantId !== membership.tenantId ||
    version.purpose !== profile.purpose
  ) {
    return { status: "not_found" };
  }
  const prefix = imageVersionPrefix(version.tenantId, version.assetId, version.version);
  const image = { assetId: version.assetId, version: version.version };
  const preview = () => deps.media.signedPreviewUrl(`${prefix}${profile.previewFile}`);
  if (version.status === "ready") return { status: "ready", image, previewUrl: await preview() };
  if (version.status === "rejected") return { status: "rejected", problem: "unreadable" };

  const bytes = await deps.admin.readOriginal(version.originalPath);
  if (bytes === null) return { status: "not_uploaded" };

  const info = inspectImage(bytes);
  const problem = checkUploadedImage(profile.rules, info, bytes.byteLength, version.declaredMime);
  if (problem !== null || info === null) {
    const reason = problem ?? "unreadable";
    await deps.admin.reject(version.versionId, reason, version.originalPath);
    return { status: "rejected", problem: reason };
  }

  let derivatives;
  try {
    derivatives = await profile.derive(deps.processor, bytes);
  } catch {
    await deps.admin.reject(version.versionId, "unreadable", version.originalPath);
    return { status: "rejected", problem: "unreadable" };
  }

  await deps.admin.storeDerivatives(prefix, derivatives);
  await deps.admin.complete(version.versionId, {
    mime: info.mime,
    bytes: bytes.byteLength,
    width: info.width,
    height: info.height,
    sha256: await sha256Hex(bytes),
  });
  return { status: "ready", image, previewUrl: await preview() };
}

/** Path (in either bucket) of one derivative of an image version. */
export function imageFilePath(
  tenantId: string,
  image: ImageVersionReference,
  file: string,
): string {
  return `${imageVersionPrefix(tenantId, image.assetId, image.version)}${file}`;
}

import type { OrganizationMembership } from "../../contracts/organization";
import type { TenantPresentation } from "../../contracts/presentation";
import { inspectImage } from "../../domain/media/image";
import {
  checkDeclaredLogo,
  checkUploadedLogo,
  LOGO_FILES,
  type LogoProblem,
} from "../../domain/media/logo";
import { canManageBranding } from "../branding/branding";
import {
  imageVersionPrefix,
  type ImageProcessor,
  type MediaAdmin,
  type MediaRepository,
} from "./ports";

export interface LogoReference {
  readonly assetId: string;
  readonly version: number;
}

export type RequestLogoUploadResult =
  | {
      readonly status: "upload";
      readonly versionId: string;
      readonly uploadUrl: string;
      readonly mime: string;
    }
  | { readonly status: "invalid"; readonly problem: LogoProblem }
  | { readonly status: "forbidden" | "rate_limited" };

/**
 * Step 1: reserve a logo version and hand the browser a one-time upload URL. Only the
 * declared type and size are checked here; the real bytes are checked on confirmation.
 */
export async function requestLogoUpload(
  membership: OrganizationMembership,
  input: { readonly mime: unknown; readonly bytes: unknown },
  media: MediaRepository,
): Promise<RequestLogoUploadResult> {
  if (!canManageBranding(membership.role)) return { status: "forbidden" };
  const problem = checkDeclaredLogo(input.mime, input.bytes);
  if (problem !== null) return { status: "invalid", problem };

  const mime = input.mime as "image/png" | "image/jpeg" | "image/webp";
  const created = await media.createImageUpload(
    membership.tenantId,
    "logo",
    mime,
    input.bytes as number,
  );
  if (created.status === "invalid") return { status: "invalid", problem: "unreadable" };
  if (created.status !== "created") return { status: created.status };

  return {
    status: "upload",
    versionId: created.upload.versionId,
    uploadUrl: await media.signedUploadUrl(created.upload.originalPath),
    mime,
  };
}

export type ConfirmLogoUploadResult =
  | { readonly status: "ready"; readonly logo: LogoReference; readonly previewUrl: string | null }
  | { readonly status: "rejected"; readonly problem: LogoProblem }
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
export async function confirmLogoUpload(
  membership: OrganizationMembership,
  versionId: unknown,
  deps: {
    readonly media: MediaRepository;
    readonly admin: MediaAdmin;
    readonly processor: ImageProcessor;
  },
): Promise<ConfirmLogoUploadResult> {
  if (!canManageBranding(membership.role)) return { status: "forbidden" };
  if (typeof versionId !== "string" || versionId === "") return { status: "not_found" };

  // Read with the user's own session: RLS hides versions of other tenants.
  const version = await deps.media.findVersion(versionId);
  if (version === null || version.tenantId !== membership.tenantId || version.purpose !== "logo") {
    return { status: "not_found" };
  }
  const prefix = imageVersionPrefix(version.tenantId, version.assetId, version.version);
  const logo = { assetId: version.assetId, version: version.version };
  if (version.status === "ready") {
    return {
      status: "ready",
      logo,
      previewUrl: await deps.media.signedPreviewUrl(`${prefix}logo.webp`),
    };
  }
  if (version.status === "rejected") return { status: "rejected", problem: "unreadable" };

  const bytes = await deps.admin.readOriginal(version.originalPath);
  if (bytes === null) return { status: "not_uploaded" };

  const info = inspectImage(bytes);
  const problem = checkUploadedLogo(info, bytes.byteLength, version.declaredMime);
  if (problem !== null || info === null) {
    const reason = problem ?? "unreadable";
    await deps.admin.reject(version.versionId, reason, version.originalPath);
    return { status: "rejected", problem: reason };
  }

  let derivatives;
  try {
    derivatives = await deps.processor.logoDerivatives(bytes);
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
  return {
    status: "ready",
    logo,
    previewUrl: await deps.media.signedPreviewUrl(`${prefix}logo.webp`),
  };
}

/** Preview of the logo currently in the editor (draft or published), if any. */
export async function logoPreviewUrl(
  tenantId: string,
  presentation: TenantPresentation,
  media: MediaRepository,
): Promise<string | null> {
  if (!presentation.logo) return null;
  const prefix = imageVersionPrefix(tenantId, presentation.logo.assetId, presentation.logo.version);
  return media.signedPreviewUrl(`${prefix}logo.webp`);
}

/** Publishes the logo's derivatives (no-op without a logo). Used right before the brand. */
export async function publishLogoOf(
  tenantId: string,
  presentation: TenantPresentation,
  admin: Pick<MediaAdmin, "publish">,
): Promise<void> {
  if (!presentation.logo) return;
  await admin.publish(tenantId, presentation.logo.assetId, presentation.logo.version, LOGO_FILES);
}

/** Public path (inside the public bucket) of a published logo derivative. */
export function publishedLogoPath(
  tenantId: string,
  logo: LogoReference,
  file: (typeof LOGO_FILES)[number],
): string {
  return `${imageVersionPrefix(tenantId, logo.assetId, logo.version)}${file}`;
}

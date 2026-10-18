import type { OrganizationMembership } from "../../contracts/organization";
import type { TenantPresentation } from "../../contracts/presentation";
import { LOGO_FILES, LOGO_RULES } from "../../domain/media/logo";
import type { ImageProblem } from "../../domain/media/rules";
import {
  confirmImageUpload,
  imageFilePath,
  requestImageUpload,
  type ImageProfile,
  type ImageVersionReference,
  type RequestImageUploadResult,
} from "./images";
import type { ImageProcessor, MediaAdmin, MediaRepository } from "./ports";

export type LogoReference = ImageVersionReference;

/** Logos: owners and admins; 512 px WebP for pages and PNG for app icons. */
export const LOGO_PROFILE: ImageProfile = {
  purpose: "logo",
  rules: LOGO_RULES,
  uploaders: ["owner", "admin"],
  previewFile: "logo.webp",
  derive: (processor, original) => processor.logoDerivatives(original),
};

export type RequestLogoUploadResult = RequestImageUploadResult;

export function requestLogoUpload(
  membership: OrganizationMembership,
  input: { readonly mime: unknown; readonly bytes: unknown },
  media: MediaRepository,
): Promise<RequestLogoUploadResult> {
  return requestImageUpload(membership, LOGO_PROFILE, input, media);
}

export type ConfirmLogoUploadResult =
  | { readonly status: "ready"; readonly logo: LogoReference; readonly previewUrl: string | null }
  | { readonly status: "rejected"; readonly problem: ImageProblem }
  | { readonly status: "not_uploaded" | "not_found" | "forbidden" };

export async function confirmLogoUpload(
  membership: OrganizationMembership,
  versionId: unknown,
  deps: {
    readonly media: MediaRepository;
    readonly admin: MediaAdmin;
    readonly processor: ImageProcessor;
  },
): Promise<ConfirmLogoUploadResult> {
  const result = await confirmImageUpload(membership, LOGO_PROFILE, versionId, deps);
  return result.status === "ready"
    ? { status: "ready", logo: result.image, previewUrl: result.previewUrl }
    : result;
}

/** Preview of the logo currently in the editor (draft or published), if any. */
export async function logoPreviewUrl(
  tenantId: string,
  presentation: TenantPresentation,
  media: MediaRepository,
): Promise<string | null> {
  if (!presentation.logo) return null;
  return media.signedPreviewUrl(imageFilePath(tenantId, presentation.logo, "logo.webp"));
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
  return imageFilePath(tenantId, logo, file);
}

import type { OrganizationMembership } from "../../contracts/organization";
import {
  CONTENT_IMAGE_FILES,
  CONTENT_IMAGE_RULES,
  type ContentImageFile,
} from "../../domain/media/rules";
import {
  confirmImageUpload,
  imageFilePath,
  requestImageUpload,
  type ConfirmImageUploadResult,
  type ImageProfile,
  type ImageVersionReference,
  type RequestImageUploadResult,
} from "./images";
import type { ImageProcessor, MediaAdmin, MediaRepository } from "./ports";

/** Photos of destinations: owners, admins and editors; responsive WebP derivatives. */
export const CONTENT_IMAGE_PROFILE: ImageProfile = {
  purpose: "content",
  rules: CONTENT_IMAGE_RULES,
  uploaders: ["owner", "admin", "editor"],
  previewFile: "w480.webp",
  derive: (processor, original) => processor.contentDerivatives(original),
};

export function requestContentImageUpload(
  membership: OrganizationMembership,
  input: { readonly mime: unknown; readonly bytes: unknown },
  media: MediaRepository,
): Promise<RequestImageUploadResult> {
  return requestImageUpload(membership, CONTENT_IMAGE_PROFILE, input, media);
}

export function confirmContentImageUpload(
  membership: OrganizationMembership,
  versionId: unknown,
  deps: {
    readonly media: MediaRepository;
    readonly admin: MediaAdmin;
    readonly processor: ImageProcessor;
  },
): Promise<ConfirmImageUploadResult> {
  return confirmImageUpload(membership, CONTENT_IMAGE_PROFILE, versionId, deps);
}

/** Path of one derivative of a content image (same in both buckets). */
export function contentImagePath(
  tenantId: string,
  image: ImageVersionReference,
  file: ContentImageFile,
): string {
  return imageFilePath(tenantId, image, file);
}

/** Copies the derivatives of every image to the public bucket (before publishing). */
export async function publishContentImages(
  tenantId: string,
  images: readonly ImageVersionReference[],
  admin: Pick<MediaAdmin, "publish">,
): Promise<void> {
  const seen = new Set<string>();
  for (const image of images) {
    const key = `${image.assetId}/${image.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await admin.publish(tenantId, image.assetId, image.version, CONTENT_IMAGE_FILES);
  }
}

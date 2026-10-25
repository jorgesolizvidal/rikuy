"use server";

import {
  openOrganization,
  requestModelUpload,
  saveModelPoster,
  submitModel,
  type ModelPosterOutcome,
  type ModelSubmitOutcome,
  type OrganizationMembership,
  type RequestModelUploadResult,
} from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { imageProcessor, mediaAdmin } from "@/server/media-admin";

type SessionProblem = { readonly status: "signed_out" | "forbidden" };

async function membershipFor(
  slug: unknown,
): Promise<{ membership: OrganizationMembership } | SessionProblem> {
  const actor = await currentAdminActor();
  if (actor === null) return { status: "signed_out" };
  const membership =
    typeof slug === "string"
      ? await openOrganization(actor, slug, (await adminSession()).memberships)
      : null;
  return membership === null ? { status: "forbidden" } : { membership };
}

export type StartModelUploadState = RequestModelUploadResult | SessionProblem | { status: "error" };

/**
 * Step 1: declares type and size and receives a one-time URL. The browser sends the GLB
 * straight to Storage (up to 50 MB never pass through this server).
 */
export async function startModelUploadAction(
  slug: unknown,
  file: { readonly mime: unknown; readonly bytes: unknown },
): Promise<StartModelUploadState> {
  try {
    const access = await membershipFor(slug);
    if (!("membership" in access)) return access;
    return await requestModelUpload(
      access.membership,
      { mime: file?.mime, bytes: file?.bytes },
      (await adminSession()).media,
    );
  } catch {
    return { status: "error" };
  }
}

export type SubmitModelState =
  { readonly status: ModelSubmitOutcome } | { readonly status: "signed_out" | "error" };

/** Step 2: the upload finished; the optimization runs in the background (a durable job). */
export async function submitModelAction(
  slug: unknown,
  versionId: unknown,
): Promise<SubmitModelState> {
  try {
    const access = await membershipFor(slug);
    if (!("membership" in access)) return access;
    return {
      status: await submitModel(access.membership, versionId, (await adminSession()).models),
    };
  } catch {
    return { status: "error" };
  }
}

export type ModelPosterState =
  { readonly status: ModelPosterOutcome } | { readonly status: "signed_out" | "error" };

/**
 * The poster the panel captured from its viewer (a small WebP or PNG). The server re-encodes
 * it; the database checks role, tenant and state again.
 */
export async function saveModelPosterAction(formData: FormData): Promise<ModelPosterState> {
  try {
    const access = await membershipFor(formData.get("slug"));
    if (!("membership" in access)) return access;
    const file = formData.get("poster");
    const capture = file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : null;
    const session = await adminSession();
    return {
      status: await saveModelPoster(
        access.membership,
        { versionId: formData.get("versionId"), capture },
        {
          models: session.models,
          media: session.media,
          admin: mediaAdmin(),
          processor: imageProcessor(),
        },
      ),
    };
  } catch {
    return { status: "error" };
  }
}

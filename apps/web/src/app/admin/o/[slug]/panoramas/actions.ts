"use server";

import {
  openOrganization,
  withModule,
  requestPanoramaUpload,
  submitPanorama,
  type OrganizationMembership,
  type PanoramaSubmitOutcome,
  type RequestPanoramaUploadResult,
} from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";

type SessionProblem = { readonly status: "signed_out" | "forbidden" };

async function membershipFor(
  slug: unknown,
): Promise<{ membership: OrganizationMembership } | SessionProblem> {
  const actor = await currentAdminActor();
  if (actor === null) return { status: "signed_out" };
  const membership =
    typeof slug === "string"
      ? withModule(await openOrganization(actor, slug, (await adminSession()).memberships), "tours")
      : null;
  return membership === null ? { status: "forbidden" } : { membership };
}

export type StartPanoramaUploadState =
  RequestPanoramaUploadResult | SessionProblem | { status: "error" };

/**
 * Step 1: declares type and size and receives a one-time URL. The browser sends the file
 * straight to Storage (up to 50 MB never pass through this server).
 */
export async function startPanoramaUploadAction(
  slug: unknown,
  file: { readonly mime: unknown; readonly bytes: unknown },
  /** The asset this upload replaces (a new version of it, ADR-048). */
  replaces?: unknown,
): Promise<StartPanoramaUploadState> {
  try {
    const access = await membershipFor(slug);
    if (!("membership" in access)) return access;
    return await requestPanoramaUpload(
      access.membership,
      {
        mime: file?.mime,
        bytes: file?.bytes,
        ...(replaces === undefined ? {} : { replaces }),
      },
      (await adminSession()).media,
    );
  } catch {
    return { status: "error" };
  }
}

export type SubmitPanoramaState =
  { readonly status: PanoramaSubmitOutcome } | { readonly status: "signed_out" | "error" };

/** Step 2: the upload finished; processing continues in the background (a durable job). */
export async function submitPanoramaAction(
  slug: unknown,
  versionId: unknown,
): Promise<SubmitPanoramaState> {
  try {
    const access = await membershipFor(slug);
    if (!("membership" in access)) return access;
    return {
      status: await submitPanorama(access.membership, versionId, (await adminSession()).panoramas),
    };
  } catch {
    return { status: "error" };
  }
}

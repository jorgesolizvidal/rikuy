"use server";

import {
  confirmLogoUpload,
  openOrganization,
  publishBranding,
  requestLogoUpload,
  saveBrandingDraft,
  type ConfirmLogoUploadResult,
  type OrganizationMembership,
  type RequestLogoUploadResult,
} from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { imageProcessor, mediaAdmin } from "@/server/media-admin";

import { fieldErrors, presentationInputFromForm, type BrandingField } from "./branding-fields";

export interface BrandingFormState {
  readonly status:
    "idle" | "saved" | "published" | "invalid" | "conflict" | "forbidden" | "signed_out" | "error";
  /** Draft revision the next save must send (null: no open draft). */
  readonly revision: number | null;
  readonly version?: number;
  readonly errors?: Partial<Record<BrandingField, string>>;
}

function parseRevision(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value === "") return null;
  const revision = Number(value);
  return Number.isInteger(revision) && revision > 0 ? revision : null;
}

/**
 * Saves the brand as a draft (`intent=save`) or saves and publishes it (`intent=publish`).
 * Returns state only: the browser stays on the page (no redirects in Server Actions).
 * Authorization is re-checked here and again inside the database.
 */
export async function brandingAction(
  previous: BrandingFormState,
  formData: FormData,
): Promise<BrandingFormState> {
  const expected = parseRevision(formData.get("revision"));
  const slug = formData.get("slug");
  const keep = { revision: expected };

  try {
    const actor = await currentAdminActor();
    if (actor === null) return { status: "signed_out", ...keep };
    const session = await adminSession();
    const membership =
      typeof slug === "string" ? await openOrganization(actor, slug, session.memberships) : null;
    if (membership === null) return { status: "forbidden", ...keep };

    const input = presentationInputFromForm(formData);
    const result =
      formData.get("intent") === "publish"
        ? await publishBranding(membership, input, expected, session.config, mediaAdmin())
        : await saveBrandingDraft(membership, input, expected, session.config);

    switch (result.status) {
      case "saved":
        return { status: "saved", revision: result.revision };
      case "published":
        return { status: "published", revision: null, version: result.version };
      case "invalid":
        return { status: "invalid", ...keep, errors: fieldErrors(result.issues, input.social) };
      case "conflict":
      case "forbidden":
        return { status: result.status, ...keep };
      case "not_found":
        return { status: "conflict", ...keep };
    }
  } catch {
    return { status: "error", revision: previous.revision ?? expected };
  }
}

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

export type StartLogoUploadState = RequestLogoUploadResult | SessionProblem | { status: "error" };

/**
 * Logo step 1: declares type and size and receives a one-time URL. The browser then sends
 * the file straight to Storage; the bytes never pass through this server.
 */
export async function startLogoUploadAction(
  slug: unknown,
  file: { readonly mime: unknown; readonly bytes: unknown },
): Promise<StartLogoUploadState> {
  try {
    const access = await membershipFor(slug);
    if (!("membership" in access)) return access;
    return await requestLogoUpload(
      access.membership,
      { mime: file?.mime, bytes: file?.bytes },
      (await adminSession()).media,
    );
  } catch {
    return { status: "error" };
  }
}

export type ConfirmLogoUploadState = ConfirmLogoUploadResult | SessionProblem | { status: "error" };

/** Logo step 2: the server inspects the uploaded bytes and prepares the derivatives. */
export async function confirmLogoUploadAction(
  slug: unknown,
  versionId: unknown,
): Promise<ConfirmLogoUploadState> {
  try {
    const access = await membershipFor(slug);
    if (!("membership" in access)) return access;
    return await confirmLogoUpload(access.membership, versionId, {
      media: (await adminSession()).media,
      admin: mediaAdmin(),
      processor: imageProcessor(),
    });
  } catch {
    return { status: "error" };
  }
}

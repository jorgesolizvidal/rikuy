"use server";

import { openOrganization, publishBranding, saveBrandingDraft } from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";

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
        ? await publishBranding(membership, input, expected, session.config)
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

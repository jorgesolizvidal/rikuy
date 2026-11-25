"use server";

import { openOrganization, saveContentWebLink } from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";

// No redirects (CONTRIBUTING §1.2): the client refreshes on success.

export interface WebLinkState {
  readonly status:
    "idle" | "saved" | "invalid" | "origin" | "not_found" | "forbidden" | "signed_out" | "error";
  readonly url?: string | null;
}

/**
 * «Página en la web del municipio» of a destination, event, notice, service or story (ADR-071).
 * The answers of the assistant link there inside the website, or always without a portal; it
 * takes effect at once (no version), so only owners and admins set it.
 */
export async function saveWebLinkAction(
  _previous: WebLinkState,
  formData: FormData,
): Promise<WebLinkState> {
  try {
    const actor = await currentAdminActor();
    if (actor === null) return { status: "signed_out" };
    const session = await adminSession();
    const org = formData.get("org");
    const membership =
      typeof org === "string" ? await openOrganization(actor, org, session.memberships) : null;
    if (membership === null) return { status: "forbidden" };
    const result = await saveContentWebLink(
      membership,
      formData.get("contentId"),
      formData.get("clear") === "1" ? "" : formData.get("url"),
      session.embed,
    );
    return result.status === "saved" ? { status: "saved", url: result.url } : result;
  } catch {
    return { status: "error" };
  }
}

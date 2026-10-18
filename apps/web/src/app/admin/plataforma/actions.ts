"use server";

import {
  changeTenantStatus,
  provisionTenant,
  startOperatorEnrollment,
  verifyOperatorCode,
  type ProvisionField,
} from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { identityAdmin } from "@/server/identity-admin";
import { platformSettings } from "@/server/platform";

// Every action re-checks the operator (and its second factor) through the use cases and
// again in the database. None of them redirects: the client navigates on success.

export type EnrollState =
  | { readonly status: "idle" | "denied" | "error" }
  | {
      readonly status: "enrolling";
      readonly factorId: string;
      readonly qrCode: string;
      readonly secret: string;
    };

export async function startEnrollmentAction(): Promise<EnrollState> {
  try {
    if ((await currentAdminActor()) === null) return { status: "denied" };
    const { platform, mfa } = await adminSession();
    const enrollment = await startOperatorEnrollment(platform, mfa);
    return enrollment ? { status: "enrolling", ...enrollment } : { status: "denied" };
  } catch {
    return { status: "error" };
  }
}

export interface VerifyState {
  readonly status: "idle" | "verified" | "invalid_code" | "rate_limited" | "unavailable" | "denied";
}

export async function verifyOperatorAction(
  _previous: VerifyState,
  formData: FormData,
): Promise<VerifyState> {
  try {
    if ((await currentAdminActor()) === null) return { status: "denied" };
    const { platform, mfa } = await adminSession();
    const status = await verifyOperatorCode(
      platform,
      mfa,
      formData.get("factorId"),
      formData.get("code"),
    );
    return { status };
  } catch {
    return { status: "unavailable" };
  }
}

export interface StatusState {
  readonly status:
    | "idle"
    | "updated"
    | "owner_pending"
    | "invalid_transition"
    | "not_found"
    | "forbidden"
    | "error";
}

export async function tenantStatusAction(
  _previous: StatusState,
  formData: FormData,
): Promise<StatusState> {
  try {
    const { platform } = await adminSession();
    const result = await changeTenantStatus(
      platform,
      formData.get("tenantId"),
      formData.get("status"),
    );
    return { status: result.status };
  } catch {
    return { status: "error" };
  }
}

export interface ProvisionState {
  readonly status:
    | "idle"
    | "provisioned"
    | "invalid_input"
    | "slug_taken"
    | "hostname_taken"
    | "owner_not_found"
    | "invalid"
    | "forbidden"
    | "error";
  readonly fields?: readonly ProvisionField[];
  readonly ownerEmail?: string;
  readonly portalUrl?: string;
}

export async function provisionTenantAction(
  _previous: ProvisionState,
  formData: FormData,
): Promise<ProvisionState> {
  try {
    if ((await currentAdminActor()) === null) return { status: "forbidden" };
    const { platform } = await adminSession();
    const settings = platformSettings();
    const input = {
      displayName: formData.get("displayName"),
      slug: formData.get("slug"),
      hostname: formData.get("hostname"),
      ownerEmail: formData.get("ownerEmail"),
    };
    const result = await provisionTenant(input, {
      platform,
      // Resolved lazily: the secret key is only read once the operator check passed
      // inside the use case (ensureUser is called after it).
      identity: { ensureUser: (email) => identityAdmin().ensureUser(email) },
      hosts: settings.hosts,
    });
    if (result.status === "invalid_input") return { status: result.status, fields: result.fields };
    if (result.status !== "provisioned") return { status: result.status };
    const hostname = String(input.hostname).trim().toLowerCase();
    return {
      status: "provisioned",
      ownerEmail: String(input.ownerEmail).trim().toLowerCase(),
      portalUrl: settings.portalOrigin(hostname),
    };
  } catch {
    return { status: "error" };
  }
}

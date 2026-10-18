import type { MembershipRole } from "../../contracts/organization";

export type TenantStatus = "provisioning" | "active" | "suspended";
export type MembershipStatus = "invited" | "active" | "revoked";

/** 'none': not an operator · 'needs_mfa': operator, session without a second factor · 'ok'. */
export type OperatorAccess = "none" | "needs_mfa" | "ok";

export interface PlatformTenantSummary {
  readonly tenantId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly status: TenantStatus;
  readonly canonicalHost: string | null;
  readonly ownerEmail: string | null;
  readonly ownerStatus: MembershipStatus | null;
  readonly createdAt: string;
}

export interface ProvisionRequest {
  readonly slug: string;
  readonly displayName: string;
  readonly hostname: string;
  readonly ownerUserId: string;
  readonly defaultLocale: string;
  readonly timezone: string;
}

export type ProvisionOutcome =
  | { readonly status: "provisioned"; readonly tenantId: string }
  | { readonly status: "slug_taken" }
  | { readonly status: "hostname_taken" }
  | { readonly status: "owner_not_found" }
  | { readonly status: "invalid" }
  | { readonly status: "forbidden" };

export type TenantStatusChangeOutcome =
  | { readonly status: "updated" }
  | { readonly status: "owner_pending" }
  | { readonly status: "invalid_transition" }
  | { readonly status: "not_found" }
  | { readonly status: "forbidden" };

/** Platform operations, executed with the operator's own session (aal2 checked in the DB). */
export interface PlatformRepository {
  operatorAccess(): Promise<OperatorAccess>;
  listTenants(): Promise<PlatformTenantSummary[]>;
  provision(request: ProvisionRequest): Promise<ProvisionOutcome>;
  setStatus(tenantId: string, status: "active" | "suspended"): Promise<TenantStatusChangeOutcome>;
}

/**
 * Isolated identity administration (secret key, server only). Creates a confirmed account
 * for an invited email, or returns the existing one. Never exposed to user input other
 * than an already validated email, and only called after the caller was authorized.
 */
export interface IdentityAdmin {
  ensureUser(email: string): Promise<{ readonly userId: string; readonly created: boolean }>;
}

export interface PendingInvitation {
  readonly tenantId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly role: MembershipRole;
  readonly invitedAt: string;
}

export interface InvitationRepository {
  listPending(): Promise<PendingInvitation[]>;
  accept(tenantId: string): Promise<"accepted" | "not_found">;
}

export interface TenantMember {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
  readonly invitedAt: string;
  readonly acceptedAt: string | null;
}

export type MemberChangeOutcome =
  | { readonly status: "done" }
  | { readonly status: "forbidden" }
  | { readonly status: "not_found" }
  | { readonly status: "last_owner" }
  | { readonly status: "already_member" };

export interface MemberRepository {
  list(tenantId: string): Promise<TenantMember[]>;
  add(tenantId: string, userId: string, role: MembershipRole): Promise<MemberChangeOutcome>;
  changeRole(
    tenantId: string,
    membershipId: string,
    role: MembershipRole,
  ): Promise<MemberChangeOutcome>;
  revoke(tenantId: string, membershipId: string): Promise<MemberChangeOutcome>;
}

export type AssuranceLevel = "aal1" | "aal2";

export interface TotpEnrollment {
  readonly factorId: string;
  /** SVG image as a data URI, rendered as <img>. */
  readonly qrCode: string;
  /** Base32 secret for manual entry. */
  readonly secret: string;
}

export type TotpVerifyOutcome = "verified" | "invalid_code" | "rate_limited" | "unavailable";

/** Second factor (TOTP) of the signed-in user. */
export interface MfaGateway {
  assurance(): Promise<{ readonly current: AssuranceLevel; readonly next: AssuranceLevel }>;
  verifiedTotpFactorIds(): Promise<string[]>;
  /** Removes abandoned, unverified factors first so enrollment can be retried. */
  enrollTotp(): Promise<TotpEnrollment | null>;
  verifyTotp(factorId: string, code: string): Promise<TotpVerifyOutcome>;
}

import { createClient, type AuthError, type PostgrestError } from "@supabase/supabase-js";
import type {
  IdentityAdmin,
  InvitationRepository,
  MemberChangeOutcome,
  MemberRepository,
  MfaGateway,
  OperatorAccess,
  PendingInvitation,
  PlatformRepository,
  PlatformTenantSummary,
  ProvisionOutcome,
  TenantMember,
  TenantStatusChangeOutcome,
  TotpEnrollment,
  TotpVerifyOutcome,
} from "@rikuy/core";
import { z } from "zod";

import type { SessionClient } from "./session-client";

/**
 * Platform onboarding, invitations, members and MFA (migration 20261018000000).
 *
 * Everything except `createSupabaseIdentityAdmin` runs with the signed-in user's JWT:
 * the database checks operator status (with aal2), membership roles and role rules.
 */

interface RpcError {
  readonly code: string;
  readonly hint: string | null;
}

function rpcError(error: PostgrestError): RpcError {
  return { code: error.code ?? "", hint: error.hint ?? null };
}

function unexpected(operation: string, error: { code?: string | undefined }): Error {
  return new Error(`${operation} failed (${error.code || "unknown"})`);
}

const roleSchema = z.enum(["owner", "admin", "editor", "analyst"]);
const membershipStatusSchema = z.enum(["invited", "active", "revoked"]);

const tenantRowSchema = z.object({
  tenant_id: z.uuid(),
  slug: z.string(),
  display_name: z.string(),
  status: z.enum(["provisioning", "active", "suspended"]),
  canonical_host: z.string().nullable(),
  owner_email: z.string().nullable(),
  owner_status: membershipStatusSchema.nullable(),
  created_at: z.string(),
});

export function createPlatformRepository(client: SessionClient): PlatformRepository {
  return {
    async operatorAccess(): Promise<OperatorAccess> {
      const { data, error } = await client.rpc("platform_operator_status");
      if (error) throw unexpected("Reading operator status", error);
      return z.enum(["none", "needs_mfa", "ok"]).parse(data);
    },

    async listTenants(): Promise<PlatformTenantSummary[]> {
      const { data, error } = await client.rpc("platform_list_tenants");
      if (error) throw unexpected("Listing tenants", error);
      return z
        .array(tenantRowSchema)
        .parse(data)
        .map((row) => ({
          tenantId: row.tenant_id,
          slug: row.slug,
          displayName: row.display_name,
          status: row.status,
          canonicalHost: row.canonical_host,
          ownerEmail: row.owner_email,
          ownerStatus: row.owner_status,
          createdAt: row.created_at,
        }));
    },

    async provision(request): Promise<ProvisionOutcome> {
      const { data, error } = await client.rpc("provision_tenant", {
        p_slug: request.slug,
        p_display_name: request.displayName,
        p_hostname: request.hostname,
        p_owner_user_id: request.ownerUserId,
        p_default_locale: request.defaultLocale,
        p_timezone: request.timezone,
      });
      if (error) {
        const { code, hint } = rpcError(error);
        if (code === "42501") return { status: "forbidden" };
        if (code === "PT409")
          return { status: hint === "hostname" ? "hostname_taken" : "slug_taken" };
        if (code === "PT404") return { status: "owner_not_found" };
        if (code === "23514") return { status: "invalid" };
        throw unexpected("Provisioning", error);
      }
      const [row] = z
        .array(z.object({ tenant_id: z.uuid() }))
        .length(1)
        .parse(data);
      if (!row) throw new Error("Provisioning returned no row");
      return { status: "provisioned", tenantId: row.tenant_id };
    },

    async setStatus(tenantId, status): Promise<TenantStatusChangeOutcome> {
      const { error } = await client.rpc("set_tenant_status", {
        p_tenant_id: tenantId,
        p_status: status,
      });
      if (!error) return { status: "updated" };
      const { code, hint } = rpcError(error);
      if (code === "42501") return { status: "forbidden" };
      if (code === "PT404") return { status: "not_found" };
      if (code === "PT409") {
        return { status: hint === "owner_pending" ? "owner_pending" : "invalid_transition" };
      }
      throw unexpected("Changing tenant status", error);
    },
  };
}

export function createInvitationRepository(client: SessionClient): InvitationRepository {
  return {
    async listPending(): Promise<PendingInvitation[]> {
      const { data, error } = await client.rpc("my_pending_invitations");
      if (error) throw unexpected("Listing invitations", error);
      return z
        .array(
          z.object({
            tenant_id: z.uuid(),
            slug: z.string(),
            display_name: z.string(),
            role: roleSchema,
            invited_at: z.string(),
          }),
        )
        .parse(data)
        .map((row) => ({
          tenantId: row.tenant_id,
          slug: row.slug,
          displayName: row.display_name,
          role: row.role,
          invitedAt: row.invited_at,
        }));
    },

    async accept(tenantId) {
      const { error } = await client.rpc("accept_membership_invitation", { p_tenant_id: tenantId });
      if (!error) return "accepted";
      if (rpcError(error).code === "PT404") return "not_found";
      throw unexpected("Accepting the invitation", error);
    },
  };
}

function memberOutcome(operation: string, error: PostgrestError | null): MemberChangeOutcome {
  if (!error) return { status: "done" };
  const { code, hint } = rpcError(error);
  if (code === "42501") return { status: "forbidden" };
  if (code === "PT404") return { status: "not_found" };
  if (code === "PT409") return { status: hint === "last_owner" ? "last_owner" : "already_member" };
  throw unexpected(operation, error);
}

export function createMemberRepository(client: SessionClient): MemberRepository {
  return {
    async list(tenantId): Promise<TenantMember[]> {
      const { data, error } = await client.rpc("list_tenant_members", { p_tenant_id: tenantId });
      if (error) throw unexpected("Listing members", error);
      return z
        .array(
          z.object({
            membership_id: z.uuid(),
            user_id: z.uuid(),
            email: z.string(),
            role: roleSchema,
            status: membershipStatusSchema,
            invited_at: z.string(),
            accepted_at: z.string().nullable(),
          }),
        )
        .parse(data)
        .map((row) => ({
          membershipId: row.membership_id,
          userId: row.user_id,
          email: row.email,
          role: row.role,
          status: row.status,
          invitedAt: row.invited_at,
          acceptedAt: row.accepted_at,
        }));
    },
    async add(tenantId, userId, role) {
      const { error } = await client.rpc("add_tenant_member", {
        p_tenant_id: tenantId,
        p_user_id: userId,
        p_role: role,
      });
      return memberOutcome("Inviting a member", error);
    },
    async changeRole(tenantId, membershipId, role) {
      const { error } = await client.rpc("change_member_role", {
        p_tenant_id: tenantId,
        p_membership_id: membershipId,
        p_role: role,
      });
      return memberOutcome("Changing a role", error);
    },
    async revoke(tenantId, membershipId) {
      const { error } = await client.rpc("revoke_member", {
        p_tenant_id: tenantId,
        p_membership_id: membershipId,
      });
      return memberOutcome("Revoking a member", error);
    },
  };
}

/**
 * supabase-js returns the QR as `data:image/svg+xml;utf-8,<svg …>` with the markup NOT
 * percent-encoded, so any `#` in the SVG (colors) cuts the URI short. Re-encode it.
 */
export function svgDataUri(qrCode: string): string {
  const markup = qrCode.startsWith("data:") ? qrCode.slice(qrCode.indexOf(",") + 1) : qrCode;
  if (!markup.trimStart().startsWith("<")) return qrCode; // already base64 or encoded
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

function isRateLimited(error: AuthError): boolean {
  return error.status === 429 || (error.code?.startsWith("over_") ?? false);
}

/** TOTP second factor through the user's own session (cookies are updated on verify). */
export function createMfaGateway(client: SessionClient): MfaGateway {
  return {
    async assurance() {
      const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      if (error || !data) return { current: "aal1", next: "aal1" };
      return {
        current: data.currentLevel === "aal2" ? "aal2" : "aal1",
        next: data.nextLevel === "aal2" ? "aal2" : "aal1",
      };
    },

    async verifiedTotpFactorIds() {
      const { data, error } = await client.auth.mfa.listFactors();
      if (error) throw unexpected("Listing factors", error);
      return data.totp.map((factor) => factor.id);
    },

    async enrollTotp(): Promise<TotpEnrollment | null> {
      const existing = await client.auth.mfa.listFactors();
      if (existing.error) throw unexpected("Listing factors", existing.error);
      for (const factor of existing.data.all) {
        if (factor.factor_type === "totp" && factor.status === "unverified") {
          await client.auth.mfa.unenroll({ factorId: factor.id });
        }
      }
      const { data, error } = await client.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "Rikuy",
      });
      if (error) throw unexpected("Enrolling TOTP", error);
      return {
        factorId: data.id,
        qrCode: svgDataUri(data.totp.qr_code),
        secret: data.totp.secret,
      };
    },

    async verifyTotp(factorId, code): Promise<TotpVerifyOutcome> {
      const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code });
      if (!error) return "verified";
      if (isRateLimited(error)) return "rate_limited";
      if (error.status === undefined || error.status === 0 || error.status >= 500) {
        return "unavailable";
      }
      return "invalid_code";
    },
  };
}

export interface IdentityAdminOptions {
  readonly url: string;
  /** SUPABASE_SECRET_KEY. Server only, used by this adapter and nothing else. */
  readonly secretKey: string;
  readonly fetch?: typeof fetch;
}

/**
 * Isolated identity administration (CONTRIBUTING §1.3): the only adapter that holds the
 * secret key. Creates confirmed, passwordless accounts for invited emails; people then
 * sign in with an email code. It never decides permissions.
 */
export function createSupabaseIdentityAdmin(options: IdentityAdminOptions): IdentityAdmin {
  const admin = createClient(options.url, options.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });

  async function findByEmail(email: string): Promise<string | null> {
    const { data, error } = await admin.rpc("platform_user_id_by_email", { p_email: email });
    if (error) throw unexpected("Looking up the account", error);
    return z.uuid().nullable().parse(data);
  }

  return {
    async ensureUser(email) {
      const existing = await findByEmail(email);
      if (existing) return { userId: existing, created: false };

      const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
      if (!error && data.user) return { userId: data.user.id, created: true };
      // Lost a race with another invitation of the same email.
      if (error?.code === "email_exists" || error?.status === 422) {
        const raced = await findByEmail(email);
        if (raced) return { userId: raced, created: false };
      }
      throw unexpected("Creating the account", error ?? {});
    },
  };
}

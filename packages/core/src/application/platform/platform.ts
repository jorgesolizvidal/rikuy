import { normalizeEmail, normalizeOneTimeCode } from "../../domain/identity/email";
import { classifyHost, type PlatformHosts } from "../../domain/tenancy/host";
import { isValidSlug } from "../../domain/tenancy/slug";
import type {
  IdentityAdmin,
  MfaGateway,
  PlatformRepository,
  PlatformTenantSummary,
  ProvisionOutcome,
  TenantStatusChangeOutcome,
  TotpEnrollment,
  TotpVerifyOutcome,
} from "./ports";

/**
 * Where an operator stands when opening the platform area:
 * - `denied`: not an operator (the area does not exist for them → 404);
 * - `enroll`: operator without a TOTP factor yet;
 * - `verify`: operator with a factor, this session still needs the code;
 * - `granted`: operator with a verified second factor in this session.
 */
export type OperatorGate =
  | { readonly status: "denied" }
  | { readonly status: "enroll" }
  | { readonly status: "verify"; readonly factorId: string }
  | { readonly status: "granted" };

export async function operatorGate(
  platform: PlatformRepository,
  mfa: MfaGateway,
): Promise<OperatorGate> {
  const access = await platform.operatorAccess();
  if (access === "none") return { status: "denied" };
  if (access === "ok") return { status: "granted" };
  const [factorId] = await mfa.verifiedTotpFactorIds();
  return factorId ? { status: "verify", factorId } : { status: "enroll" };
}

/** Starts TOTP enrollment for an operator. Non-operators never get a factor from here. */
export async function startOperatorEnrollment(
  platform: PlatformRepository,
  mfa: MfaGateway,
): Promise<TotpEnrollment | null> {
  const gate = await operatorGate(platform, mfa);
  return gate.status === "enroll" ? mfa.enrollTotp() : null;
}

export async function verifyOperatorCode(
  platform: PlatformRepository,
  mfa: MfaGateway,
  factorId: unknown,
  code: unknown,
): Promise<TotpVerifyOutcome | "denied"> {
  if ((await platform.operatorAccess()) === "none") return "denied";
  const normalized = normalizeOneTimeCode(code);
  if (normalized === null || typeof factorId !== "string" || factorId === "") {
    return "invalid_code";
  }
  return mfa.verifyTotp(factorId, normalized);
}

export async function listPlatformTenants(
  platform: PlatformRepository,
): Promise<PlatformTenantSummary[] | null> {
  if ((await platform.operatorAccess()) !== "ok") return null;
  return platform.listTenants();
}

/** `{slug}.{rootDomain}` — the default portal host of a new municipality. */
export function suggestPortalHostname(slug: string, hosts: PlatformHosts): string {
  return `${slug}.${hosts.rootDomain}`;
}

export type ProvisionField = "displayName" | "slug" | "hostname" | "ownerEmail";

export type ProvisionTenantResult =
  | ProvisionOutcome
  | { readonly status: "invalid_input"; readonly fields: readonly ProvisionField[] };

export interface ProvisionTenantDeps {
  readonly platform: PlatformRepository;
  readonly identity: IdentityAdmin;
  readonly hosts: PlatformHosts;
}

/**
 * Onboards a municipality: validates the request, makes sure the owner has an account
 * (identity admin) and provisions tenant + domain + invited owner in one transaction.
 * The operator check runs first, so no account is ever created for an unauthorized call.
 * Nothing here is specific to a municipality: a new tenant needs no code or env change.
 */
export async function provisionTenant(
  input: {
    readonly displayName: unknown;
    readonly slug: unknown;
    readonly hostname: unknown;
    readonly ownerEmail: unknown;
  },
  deps: ProvisionTenantDeps,
): Promise<ProvisionTenantResult> {
  if ((await deps.platform.operatorAccess()) !== "ok") return { status: "forbidden" };

  const fields: ProvisionField[] = [];
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  if (displayName.length < 1 || displayName.length > 120 || /\p{Cc}/u.test(displayName)) {
    fields.push("displayName");
  }
  const slug = typeof input.slug === "string" ? input.slug.trim().toLowerCase() : "";
  if (!isValidSlug(slug)) fields.push("slug");

  const rawHost = typeof input.hostname === "string" ? input.hostname.trim() : "";
  // Only plain portal hosts: never the admin host, the platform apex, a port or a path.
  const surface = rawHost.includes(":") ? null : classifyHost(rawHost, deps.hosts);
  const hostname = surface?.kind === "portal" ? surface.hostname : null;
  if (hostname === null) fields.push("hostname");

  const ownerEmail = normalizeEmail(input.ownerEmail);
  if (ownerEmail === null) fields.push("ownerEmail");

  if (fields.length > 0 || hostname === null || ownerEmail === null) {
    return { status: "invalid_input", fields };
  }

  const owner = await deps.identity.ensureUser(ownerEmail);
  return deps.platform.provision({
    slug,
    displayName,
    hostname,
    ownerUserId: owner.userId,
    defaultLocale: "es",
    timezone: "America/La_Paz",
  });
}

export async function changeTenantStatus(
  platform: PlatformRepository,
  tenantId: unknown,
  status: unknown,
): Promise<TenantStatusChangeOutcome> {
  if (typeof tenantId !== "string" || (status !== "active" && status !== "suspended")) {
    return { status: "invalid_transition" };
  }
  return platform.setStatus(tenantId, status);
}

import type { MembershipRole, OrganizationMembership } from "../../contracts/organization";
import { isPassportId, isStampCode, type PassportStamp } from "../../domain/passport/stamps";
import { PORTAL_PATHS } from "../content/portal";
import type { PublishedImage } from "../content/ports";

/**
 * Stamps of the tourist passport (C2 · Paso 2, ADR-057): the stamp code of each stop (the
 * panel prints it as a QR; owners and admins renew it) and the portal's stamping.
 */

export interface StampCode {
  readonly contentId: string;
  readonly slug: string;
  readonly title: string;
  readonly published: boolean;
  /** What the QR carries. Secret: whoever has it can stamp. */
  readonly code: string;
  readonly version: number;
  readonly createdAt: string;
  readonly renewedAt: string | null;
  readonly circuits: readonly { readonly name: string; readonly status: "draft" | "published" }[];
}

export type RenewStampCodeOutcome =
  | { readonly status: "renewed"; readonly version: number }
  | { readonly status: "stale" }
  | { readonly status: "forbidden" }
  | { readonly status: "not_found" };

/** With the signed-in user's session (the RPCs check the role again). */
export interface StampCodeRepository {
  list(tenantId: string): Promise<StampCode[]>;
  renew(tenantId: string, contentId: string, version: number): Promise<RenewStampCodeOutcome>;
}

/** The codes are what gets printed: owners, admins and editors; not analysts. */
export function canSeeStampCodes(role: MembershipRole): boolean {
  return role === "owner" || role === "admin" || role === "editor";
}

export function canRenewStampCodes(role: MembershipRole): boolean {
  return role === "owner" || role === "admin";
}

/** The address a stamp QR opens. */
export function stampUrl(portalOrigin: string, code: string): string {
  return new URL(PORTAL_PATHS.stamp(code), portalOrigin).toString();
}

/** The codes of every stop, or null for someone who cannot see them. */
export async function loadStampCodes(
  membership: OrganizationMembership,
  repository: StampCodeRepository,
): Promise<StampCode[] | null> {
  if (!canSeeStampCodes(membership.role)) return null;
  return repository.list(membership.tenantId);
}

/** «Renovar el QR»: the printed code stops stamping; stamps on phones stay valid. */
export async function renewStampCode(
  membership: OrganizationMembership,
  repository: StampCodeRepository,
  contentId: string,
  version: number,
): Promise<RenewStampCodeOutcome> {
  if (!canRenewStampCodes(membership.role)) return { status: "forbidden" };
  return repository.renew(membership.tenantId, contentId, version);
}

// ── The portal ──────────────────────────────────────────────────────────────

export interface StampPlace {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly cover: PublishedImage | null;
}

/** Anonymous: the place of a current stamp code and the stamp itself, signed. */
export interface PublishedStampReader {
  place(tenantId: string, code: string): Promise<StampPlace | null>;
  collect(
    tenantId: string,
    code: string,
    passportId: string,
    located: boolean,
  ): Promise<PassportStamp | null>;
}

export type CollectStampOutcome =
  | { readonly status: "stamped"; readonly stamp: PassportStamp }
  | { readonly status: "invalid" }
  /** Renewed, unpublished, not in a published circuit, another municipality's. */
  | { readonly status: "not_found" };

/** `POST /sellar` with `{ code, passport, located }`: the stamp for the phone to keep. */
export async function collectStamp(
  reader: PublishedStampReader,
  tenantId: string,
  body: unknown,
): Promise<CollectStampOutcome> {
  if (typeof body !== "object" || body === null) return { status: "invalid" };
  const { code, passport, located } = body as Record<string, unknown>;
  if (!isStampCode(code) || !isPassportId(passport) || typeof located !== "boolean") {
    return { status: "invalid" };
  }
  const stamp = await reader.collect(tenantId, code, passport, located);
  return stamp ? { status: "stamped", stamp } : { status: "not_found" };
}

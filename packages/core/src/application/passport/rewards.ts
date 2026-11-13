import type { MembershipRole, OrganizationMembership } from "../../contracts/organization";
import { isRedeemPin, normalizeVoucherCode } from "../../domain/passport/rewards";
import { isPassportId } from "../../domain/passport/stamps";

/**
 * The prize of the tourist passport (C2 · Paso 3, ADR-058). The phone asks for a voucher with
 * its stamps (the database checks each signature); the shop redeems it once, in the portal,
 * with the code and the key the municipality set for the circuit.
 */

export type VoucherStatus =
  /** Given now. */
  | "issued"
  /** Given before and not redeemed yet. */
  | "active"
  /** This passport already got the prize of the circuit. */
  | "redeemed";

export interface VoucherView {
  readonly code: string;
  readonly circuit: string;
  readonly circuitName: string;
  readonly reward: string;
  readonly stampsTotal: number;
  readonly stampsLocated: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly redeemedAt: string | null;
}

export type RequestVoucherOutcome =
  | { readonly status: VoucherStatus; readonly voucher: VoucherView }
  | { readonly status: "incomplete"; readonly missing: number }
  | { readonly status: "no_reward" | "not_found" | "invalid" };

export type RedeemVoucherOutcome =
  | {
      readonly status: "valid" | "redeemed" | "already_redeemed" | "expired";
      readonly voucher: VoucherView;
    }
  | { readonly status: "no_pin"; readonly circuitName: string }
  | { readonly status: "wrong" | "too_many" | "invalid" };

export interface VoucherStamp {
  readonly placeId: string;
  readonly at: number;
  readonly located: boolean;
  readonly signature: string;
}

/** Anonymous: what the portal asks the database. */
export interface PublishedRewardReader {
  requestVoucher(
    tenantId: string,
    circuit: string,
    passportId: string,
    stamps: readonly VoucherStamp[],
  ): Promise<RequestVoucherOutcome>;
  redeemVoucher(
    tenantId: string,
    code: string,
    pin: string,
    redeem: boolean,
  ): Promise<RedeemVoucherOutcome>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CIRCUIT = /^[a-z0-9-]{1,80}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/u;
const MAX_STAMPS = 60;

function voucherStamp(value: unknown): VoucherStamp | null {
  if (typeof value !== "object" || value === null) return null;
  const stamp = value as Record<string, unknown>;
  if (
    typeof stamp.placeId !== "string" ||
    !UUID.test(stamp.placeId) ||
    typeof stamp.at !== "number" ||
    !Number.isSafeInteger(stamp.at) ||
    stamp.at <= 0 ||
    typeof stamp.located !== "boolean" ||
    typeof stamp.signature !== "string" ||
    !SIGNATURE.test(stamp.signature)
  ) {
    return null;
  }
  return {
    placeId: stamp.placeId,
    at: stamp.at,
    located: stamp.located,
    signature: stamp.signature,
  };
}

/** `POST /premio` with `{ circuit, passport, stamps }`. */
export async function requestVoucher(
  reader: PublishedRewardReader,
  tenantId: string,
  body: unknown,
): Promise<RequestVoucherOutcome> {
  if (typeof body !== "object" || body === null) return { status: "invalid" };
  const { circuit, passport, stamps } = body as Record<string, unknown>;
  if (
    typeof circuit !== "string" ||
    !CIRCUIT.test(circuit) ||
    !isPassportId(passport) ||
    !Array.isArray(stamps) ||
    stamps.length > MAX_STAMPS
  ) {
    return { status: "invalid" };
  }
  const parsed = stamps.map(voucherStamp);
  if (parsed.some((stamp) => stamp === null)) return { status: "invalid" };
  return reader.requestVoucher(tenantId, circuit, passport, parsed as VoucherStamp[]);
}

/** `POST /canje/verificar` with `{ code, pin, redeem }`: check, or redeem once. */
export async function redeemVoucher(
  reader: PublishedRewardReader,
  tenantId: string,
  body: unknown,
): Promise<RedeemVoucherOutcome> {
  if (typeof body !== "object" || body === null) return { status: "invalid" };
  const { code, pin, redeem } = body as Record<string, unknown>;
  const normalized = normalizeVoucherCode(code);
  if (normalized === null || !isRedeemPin(pin) || typeof redeem !== "boolean") {
    return { status: "invalid" };
  }
  return reader.redeemVoucher(tenantId, normalized, pin, redeem);
}

// ── The panel ──────────────────────────────────────────────────────────────

export interface CircuitRedeemPin {
  readonly circuitId: string;
  /** When the shop's key was set; null without one (its vouchers cannot be redeemed). */
  readonly pinSetAt: string | null;
}

export type SetRedeemPinOutcome =
  | { readonly status: "saved"; readonly pinSetAt: string }
  | { readonly status: "forbidden" }
  | { readonly status: "not_found" }
  | { readonly status: "invalid" };

/** With the signed-in user's session (the RPCs check the role again). */
export interface PassportRewardRepository {
  pins(tenantId: string): Promise<CircuitRedeemPin[]>;
  setPin(tenantId: string, circuitId: string, pin: string): Promise<SetRedeemPinOutcome>;
}

/** The shop's key: owners and admins, like publishing a circuit. */
export function canSetRedeemPin(role: MembershipRole): boolean {
  return role === "owner" || role === "admin";
}

export async function setRedeemPin(
  membership: OrganizationMembership,
  repository: PassportRewardRepository,
  circuitId: string,
  pin: unknown,
): Promise<SetRedeemPinOutcome> {
  if (!canSetRedeemPin(membership.role)) return { status: "forbidden" };
  if (!isRedeemPin(pin)) return { status: "invalid" };
  return repository.setPin(membership.tenantId, circuitId, pin);
}

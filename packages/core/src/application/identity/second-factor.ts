import type { Actor } from "../../contracts/organization";
import { normalizeOneTimeCode } from "../../domain/identity/email";
import type { MfaGateway, TotpEnrollment, TotpVerifyOutcome } from "../platform/ports";
import type { MembershipReader } from "./ports";

/**
 * Second factor of the staff of a municipality (ADR-043). Owners and admins act only with a
 * verified TOTP factor in their session; the database enforces it (aal2) and these use
 * cases drive the /verificacion page:
 * - `not_needed`: no membership of this person asks for it (or the session already has it);
 * - `enroll`: they have no factor yet, they set one up;
 * - `verify`: they have one, this session still needs the code.
 * The session reaches aal2 once, for every municipality of the person.
 */
export type SecondFactorGate =
  | { readonly status: "not_needed" }
  | { readonly status: "enroll" }
  | { readonly status: "verify"; readonly factorId: string };

export async function secondFactorGate(
  actor: Actor,
  reader: MembershipReader,
  mfa: MfaGateway,
): Promise<SecondFactorGate> {
  const memberships = await reader.listActiveMemberships(actor.userId);
  if (!memberships.some((membership) => membership.needsSecondFactor)) {
    return { status: "not_needed" };
  }
  const [factorId] = await mfa.verifiedTotpFactorIds();
  return factorId ? { status: "verify", factorId } : { status: "enroll" };
}

/** Starts TOTP enrollment, only for someone the gate sends to `enroll`. */
export async function startStaffEnrollment(
  actor: Actor,
  reader: MembershipReader,
  mfa: MfaGateway,
): Promise<TotpEnrollment | null> {
  const gate = await secondFactorGate(actor, reader, mfa);
  return gate.status === "enroll" ? mfa.enrollTotp() : null;
}

/** Verifies the code of a factor (a new one, or the one they already had). */
export async function verifyStaffCode(
  actor: Actor,
  reader: MembershipReader,
  mfa: MfaGateway,
  factorId: unknown,
  code: unknown,
): Promise<TotpVerifyOutcome | "not_needed"> {
  const gate = await secondFactorGate(actor, reader, mfa);
  if (gate.status === "not_needed") return "not_needed";
  const normalized = normalizeOneTimeCode(code);
  if (normalized === null || typeof factorId !== "string" || factorId === "") {
    return "invalid_code";
  }
  return mfa.verifyTotp(factorId, normalized);
}

/** Only relative paths of the panel are followed after verifying (never another site). */
export function safePanelPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  return /^\/(?!\/)[A-Za-z0-9\-/_]{0,200}$/u.test(value) ? value : "/";
}

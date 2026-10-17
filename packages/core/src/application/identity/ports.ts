import type { Actor, OrganizationMembership } from "../../contracts/organization";

export type EmailCodeRequestOutcome = "sent" | "not_allowed" | "rate_limited" | "unavailable";
export type EmailCodeVerifyOutcome = "signed_in" | "invalid_code" | "rate_limited" | "unavailable";

/** Port: identity provider operations bound to the current request's session. */
export interface AuthGateway {
  requestEmailCode(
    email: string,
    options: { redirectTo: string },
  ): Promise<EmailCodeRequestOutcome>;
  verifyEmailCode(email: string, code: string): Promise<EmailCodeVerifyOutcome>;
  exchangeAuthCode(code: string): Promise<boolean>;
  /** Verifies the session with the identity provider (not just the cookie). */
  currentActor(): Promise<Actor | null>;
  signOut(): Promise<void>;
}

/** Port: memberships visible to the current session (enforced by RLS). */
export interface MembershipReader {
  /** Active memberships of `userId` in active tenants. */
  listActiveMemberships(userId: string): Promise<OrganizationMembership[]>;
}

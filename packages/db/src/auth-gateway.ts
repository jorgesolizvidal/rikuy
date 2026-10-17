import type {
  Actor,
  AuthGateway,
  EmailCodeRequestOutcome,
  EmailCodeVerifyOutcome,
} from "@rikuy/core";
import type { AuthError } from "@supabase/supabase-js";

import type { SessionClient } from "./session-client";

/**
 * Supabase Auth adapter for the AuthGateway port. Errors are mapped to coarse outcomes;
 * provider messages are never shown to users (they could reveal whether an account exists).
 */

function isRateLimited(error: AuthError): boolean {
  return error.status === 429 || (error.code?.startsWith("over_") ?? false);
}

// Misconfiguration of the Auth server, not a property of the account: surfacing it as
// "not allowed" would silently hide a broken login behind the anti-enumeration message.
const CONFIGURATION_ERRORS = new Set(["email_provider_disabled", "provider_disabled"]);

function isServerOrNetwork(error: AuthError): boolean {
  return (
    error.status === undefined ||
    error.status === 0 ||
    error.status >= 500 ||
    CONFIGURATION_ERRORS.has(error.code ?? "")
  );
}

export function createSupabaseAuthGateway(client: SessionClient): AuthGateway {
  return {
    async requestEmailCode(email, { redirectTo }): Promise<EmailCodeRequestOutcome> {
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
      });
      if (!error) return "sent";
      if (isRateLimited(error)) return "rate_limited";
      if (isServerOrNetwork(error)) return "unavailable";
      // Unknown or non-provisioned account (sign-ups are disabled).
      return "not_allowed";
    },

    async verifyEmailCode(email, code): Promise<EmailCodeVerifyOutcome> {
      const { data, error } = await client.auth.verifyOtp({ email, token: code, type: "email" });
      if (!error && data.session) return "signed_in";
      if (error && isRateLimited(error)) return "rate_limited";
      if (error && isServerOrNetwork(error)) return "unavailable";
      return "invalid_code";
    },

    async exchangeAuthCode(code) {
      const { error } = await client.auth.exchangeCodeForSession(code);
      return !error;
    },

    async currentActor(): Promise<Actor | null> {
      const { data, error } = await client.auth.getUser();
      if (error || !data.user) return null;
      return { userId: data.user.id, email: data.user.email ?? null };
    },

    async signOut() {
      await client.auth.signOut({ scope: "local" });
    },
  };
}

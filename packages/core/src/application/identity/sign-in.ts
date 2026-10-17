import { normalizeEmail, normalizeOneTimeCode } from "../../domain/identity/email";
import type { AuthGateway } from "./ports";

export type RequestSignInResult =
  | { readonly status: "code_sent"; readonly email: string }
  | { readonly status: "invalid_email" }
  | { readonly status: "rate_limited" }
  | { readonly status: "unavailable" };

/**
 * Starts an email sign-in. Unknown or non-provisioned emails get the SAME answer as
 * real accounts ("code_sent"), so the form cannot be used to discover who has access.
 */
export async function requestSignInCode(
  rawEmail: unknown,
  gateway: AuthGateway,
  redirectTo: string,
): Promise<RequestSignInResult> {
  const email = normalizeEmail(rawEmail);
  if (email === null) return { status: "invalid_email" };

  const outcome = await gateway.requestEmailCode(email, { redirectTo });
  switch (outcome) {
    case "sent":
    case "not_allowed":
      return { status: "code_sent", email };
    case "rate_limited":
      return { status: "rate_limited" };
    case "unavailable":
      return { status: "unavailable" };
  }
}

export type VerifySignInResult =
  | { readonly status: "signed_in" }
  | { readonly status: "invalid_input" }
  | { readonly status: "invalid_code" }
  | { readonly status: "rate_limited" }
  | { readonly status: "unavailable" };

export async function verifySignInCode(
  rawEmail: unknown,
  rawCode: unknown,
  gateway: AuthGateway,
): Promise<VerifySignInResult> {
  const email = normalizeEmail(rawEmail);
  const code = normalizeOneTimeCode(rawCode);
  if (email === null || code === null) return { status: "invalid_input" };
  return { status: await gateway.verifyEmailCode(email, code) };
}

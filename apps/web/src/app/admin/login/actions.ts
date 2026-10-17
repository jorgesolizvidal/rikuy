"use server";

import { requestSignInCode, verifySignInCode } from "@rikuy/core";
import { redirect } from "next/navigation";

import { adminSession } from "@/server/admin-session";
import { platformSettings } from "@/server/platform";

export type LoginState =
  | { readonly stage: "email"; readonly error?: string }
  | { readonly stage: "code"; readonly email: string; readonly error?: string };

const MESSAGES = {
  invalidEmail: "Escribe un correo válido.",
  invalidCode: "El código no es válido o ya venció. Revisa el correo o pide uno nuevo.",
  rateLimited: "Demasiados intentos. Espera un momento y vuelve a intentarlo.",
  unavailable: "No pudimos conectar con el servicio de acceso. Inténtalo de nuevo.",
} as const;

/** Single entry point for the login form: `intent` selects the step. */
export async function loginAction(state: LoginState, formData: FormData): Promise<LoginState> {
  switch (formData.get("intent")) {
    case "verify":
      return verifyCode(state, formData);
    case "restart":
      return { stage: "email" };
    default:
      return requestCode(formData);
  }
}

/** Step 1: send a one-time code. Same answer whether or not the account exists. */
async function requestCode(formData: FormData): Promise<LoginState> {
  const { gateway } = await adminSession();
  const result = await requestSignInCode(
    formData.get("email"),
    gateway,
    `${platformSettings().adminOrigin}/auth/callback`,
  );
  switch (result.status) {
    case "code_sent":
      return { stage: "code", email: result.email };
    case "invalid_email":
      return { stage: "email", error: MESSAGES.invalidEmail };
    case "rate_limited":
      return { stage: "email", error: MESSAGES.rateLimited };
    case "unavailable":
      return { stage: "email", error: MESSAGES.unavailable };
  }
}

/** Step 2: exchange the code for a session (cookies are written by the session client). */
async function verifyCode(state: LoginState, formData: FormData): Promise<LoginState> {
  const email = state.stage === "code" ? state.email : formData.get("email");
  const { gateway } = await adminSession();
  const result = await verifySignInCode(email, formData.get("code"), gateway);

  if (result.status === "signed_in") redirect("/");

  const safeEmail = typeof email === "string" ? email : "";
  switch (result.status) {
    case "invalid_input":
    case "invalid_code":
      return { stage: "code", email: safeEmail, error: MESSAGES.invalidCode };
    case "rate_limited":
      return { stage: "code", email: safeEmail, error: MESSAGES.rateLimited };
    case "unavailable":
      return { stage: "code", email: safeEmail, error: MESSAGES.unavailable };
  }
}

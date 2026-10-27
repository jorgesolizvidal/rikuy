import "server-only";

import { EnvValidationError, parseMailEnv } from "@rikuy/config/env";

/** Whether invitation emails go out (ADR-034): SMTP is configured and valid. */
export function invitationMailConfigured(): boolean {
  try {
    return parseMailEnv() !== null;
  } catch (error) {
    if (error instanceof EnvValidationError) return false;
    throw error;
  }
}

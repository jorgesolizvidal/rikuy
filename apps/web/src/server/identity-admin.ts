import "server-only";

import { parseServerEnv } from "@rikuy/config/env";
import type { IdentityAdmin } from "@rikuy/core";
import { createSupabaseIdentityAdmin } from "@rikuy/db";

let admin: IdentityAdmin | undefined;

/**
 * The ONLY place the web app reads SUPABASE_SECRET_KEY (CONTRIBUTING §1.3). Imported by
 * the onboarding and member Server Actions, after the use case has authorized the caller.
 */
export function identityAdmin(): IdentityAdmin {
  if (admin) return admin;
  const env = parseServerEnv();
  admin = createSupabaseIdentityAdmin({
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    secretKey: env.SUPABASE_SECRET_KEY,
  });
  return admin;
}

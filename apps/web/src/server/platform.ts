import "server-only";

import { parsePlatformEnv } from "@rikuy/config/env";
import { createCachedTenantDirectory, type PlatformHosts, type TenantDirectory } from "@rikuy/core";
import { createSupabaseTenantDirectory } from "@rikuy/db";

/**
 * Lazily built platform dependencies. Environment is read on first use (not at import
 * time) so `next build` works without credentials; a missing variable fails the request
 * loudly with the variable NAME only.
 */
let cached: { hosts: PlatformHosts; directory: TenantDirectory } | undefined;

export function platformDeps(): { hosts: PlatformHosts; directory: TenantDirectory } {
  if (cached) return cached;
  const env = parsePlatformEnv();
  cached = {
    hosts: { rootDomain: env.PLATFORM_ROOT_DOMAIN, adminHost: env.PLATFORM_ADMIN_HOST },
    directory: createCachedTenantDirectory(
      createSupabaseTenantDirectory({
        url: env.NEXT_PUBLIC_SUPABASE_URL,
        publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      }),
    ),
  };
  return cached;
}

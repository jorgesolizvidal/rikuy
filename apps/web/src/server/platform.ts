import "server-only";

import { parsePlatformEnv, type PlatformEnv } from "@rikuy/config/env";
import { createCachedTenantDirectory, type PlatformHosts, type TenantDirectory } from "@rikuy/core";
import { createSupabaseTenantDirectory } from "@rikuy/db";

/**
 * Lazily built platform dependencies. Environment is read on first use (not at import
 * time) so `next build` works without credentials; a missing variable fails the request
 * loudly with the variable NAME only.
 */
export interface PlatformSettings {
  readonly env: PlatformEnv;
  readonly hosts: PlatformHosts;
  /** Plain http is only allowed for local development on `localhost`. */
  readonly secureCookies: boolean;
  /** Absolute origin of the central admin host, e.g. `https://app.rikuy.app`. */
  readonly adminOrigin: string;
}

let settings: PlatformSettings | undefined;
let directory: TenantDirectory | undefined;

export function platformSettings(): PlatformSettings {
  if (settings) return settings;
  const env = parsePlatformEnv();
  const local = env.PLATFORM_ROOT_DOMAIN === "localhost";
  settings = {
    env,
    hosts: { rootDomain: env.PLATFORM_ROOT_DOMAIN, adminHost: env.PLATFORM_ADMIN_HOST },
    secureCookies: !local,
    adminOrigin: `${local ? "http" : "https"}://${env.PLATFORM_ADMIN_HOST}`,
  };
  return settings;
}

export function tenantDirectory(): TenantDirectory {
  if (directory) return directory;
  const { env } = platformSettings();
  directory = createCachedTenantDirectory(
    createSupabaseTenantDirectory({
      url: env.NEXT_PUBLIC_SUPABASE_URL,
      publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    }),
  );
  return directory;
}

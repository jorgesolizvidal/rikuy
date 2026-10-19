import "server-only";

import { parsePlatformEnv, type PlatformEnv } from "@rikuy/config/env";
import {
  createCachedPresentationReader,
  createCachedPublishedMapReader,
  createCachedTenantDirectory,
  type PlatformHosts,
  type PublishedDestinationReader,
  type PublishedEventReader,
  type PublishedMapReader,
  type PublishedPresentationReader,
  type TenantDirectory,
} from "@rikuy/core";
import {
  createSupabasePresentationReader,
  createSupabasePublishedContentReader,
  createSupabasePublishedEventReader,
  createSupabasePublishedMapReader,
  createSupabaseTenantDirectory,
} from "@rikuy/db";

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
  /** Public origin of a portal hostname (adds the dev port locally). */
  portalOrigin(hostname: string): string;
}

let settings: PlatformSettings | undefined;
let directory: TenantDirectory | undefined;
let presentations: PublishedPresentationReader | undefined;
let publishedContent: PublishedDestinationReader | undefined;
let publishedEvents: PublishedEventReader | undefined;
let publishedMap: PublishedMapReader | undefined;

export function platformSettings(): PlatformSettings {
  if (settings) return settings;
  const env = parsePlatformEnv();
  const local = env.PLATFORM_ROOT_DOMAIN === "localhost";
  // Locally every host shares the dev server's port (taken from the admin host).
  const devPort = local ? (env.PLATFORM_ADMIN_HOST.split(":")[1] ?? "") : "";
  settings = {
    env,
    hosts: { rootDomain: env.PLATFORM_ROOT_DOMAIN, adminHost: env.PLATFORM_ADMIN_HOST },
    secureCookies: !local,
    adminOrigin: `${local ? "http" : "https"}://${env.PLATFORM_ADMIN_HOST}`,
    portalOrigin: (hostname) =>
      `${local ? "http" : "https"}://${hostname}${devPort ? `:${devPort}` : ""}`,
  };
  return settings;
}

let freshDirectory: TenantDirectory | undefined;

/**
 * The registry without the per-instance cache, for portal pages: they are cached by host
 * themselves (ADR-024), and a rebuild right after a publication must see the new version.
 */
export function freshTenantDirectory(): TenantDirectory {
  if (freshDirectory) return freshDirectory;
  const { env } = platformSettings();
  freshDirectory = createSupabaseTenantDirectory({
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  return freshDirectory;
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

/** Anonymous reader of published presentations; sealed versions are cached per instance. */
export function presentationReader(): PublishedPresentationReader {
  if (presentations) return presentations;
  const { env } = platformSettings();
  presentations = createCachedPresentationReader(
    createSupabasePresentationReader({
      url: env.NEXT_PUBLIC_SUPABASE_URL,
      publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    }),
  );
  return presentations;
}

/**
 * Anonymous reader of published destinations (only active tenants, sealed revisions).
 * Not cached here: the pages that use it are cached per host (ADR-024), and a rebuild
 * after a publication must read the new revision.
 */
export function publishedContentReader(): PublishedDestinationReader {
  if (publishedContent) return publishedContent;
  const { env } = platformSettings();
  publishedContent = createSupabasePublishedContentReader({
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  return publishedContent;
}

/** Anonymous agenda reader, read fresh like destinations (pages are cached per host). */
export function publishedEventReader(): PublishedEventReader {
  if (publishedEvents) return publishedEvents;
  const { env } = platformSettings();
  publishedEvents = createSupabasePublishedEventReader({
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  return publishedEvents;
}

/** Anonymous map reader: places by area (snapped to a ~1 km grid) cached for 30 s. */
export function publishedMapReader(): PublishedMapReader {
  if (publishedMap) return publishedMap;
  const { env } = platformSettings();
  publishedMap = createCachedPublishedMapReader(
    createSupabasePublishedMapReader({
      url: env.NEXT_PUBLIC_SUPABASE_URL,
      publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    }),
    { ttlMs: 30_000 },
  );
  return publishedMap;
}

/**
 * @rikuy/db — data-access adapters (Supabase Data API / RPC / Auth).
 *
 * Implements the ports declared in @rikuy/core. Server-only: never import this package
 * from client components.
 */
export { createSupabaseTenantDirectory, mapTenantRow } from "./tenant-directory";
export type { SupabaseTenantDirectoryOptions } from "./tenant-directory";
export { createSessionClient, hasSessionCookies } from "./session-client";
export type {
  SessionClient,
  SessionClientOptions,
  SessionCookie,
  SessionCookieStore,
  SessionCookieToSet,
} from "./session-client";
export { createSupabaseAuthGateway } from "./auth-gateway";
export { createMembershipReader } from "./membership-reader";
export { createSupabasePresentationReader, createTenantConfigRepository } from "./tenant-config";
export type { SupabasePresentationReaderOptions } from "./tenant-config";

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
export {
  createInvitationRepository,
  createMemberRepository,
  createMfaGateway,
  createPlatformRepository,
  createSupabaseIdentityAdmin,
} from "./platform";
export type { IdentityAdminOptions } from "./platform";
export {
  createMediaRepository,
  createSharpImageProcessor,
  createSupabaseMediaAdmin,
  MEDIA_BUCKETS,
  publicMediaUrl,
} from "./media";
export type { MediaAdminOptions } from "./media";
export {
  createContentRepository,
  createSupabasePublishedContentReader,
  createSupabasePublishedEventReader,
  createSupabasePublishedMapReader,
} from "./content";
export type { SupabasePublishedContentReaderOptions } from "./content";

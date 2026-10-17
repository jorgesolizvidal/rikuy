/**
 * @rikuy/db — data-access adapters (Supabase Data API / RPC).
 *
 * Implements the repository ports declared in @rikuy/core. Server-only: never import
 * this package from client components.
 */
export { createSupabaseTenantDirectory, mapTenantRow } from "./tenant-directory";
export type { SupabaseTenantDirectoryOptions } from "./tenant-directory";

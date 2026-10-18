/**
 * @rikuy/core — framework-free heart of the platform.
 *
 * - `domain/`      pure business rules (host classification, publication, tour graph…)
 * - `application/` use cases: validate intent → authorize → call repository ports
 * - `contracts/`   versioned DTOs and schemas shared by web, worker and tests
 *
 * Nothing here may import Next.js, React, Supabase, AI SDKs or job runtimes
 * (enforced by ESLint). Modules are added phase by phase; see docs/roadmap.md.
 */
export * from "./domain/tenancy/host";
export * from "./contracts/tenant";
export * from "./application/tenancy/resolve-portal-tenant";
export * from "./application/tenancy/cached-tenant-directory";
export * from "./domain/identity/email";
export * from "./contracts/organization";
export * from "./application/identity/ports";
export * from "./application/identity/sign-in";
export * from "./application/identity/organizations";
export * from "./domain/branding/color";
export * from "./domain/branding/theme";
export * from "./contracts/presentation";
export * from "./application/branding/ports";
export * from "./application/branding/branding";
export * from "./application/branding/cached-presentation-reader";
export * from "./application/branding/manifest";
export * from "./domain/tenancy/slug";
export * from "./application/platform/ports";
export * from "./application/platform/platform";
export * from "./application/platform/members";

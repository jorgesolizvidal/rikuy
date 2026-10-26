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
export * from "./domain/media/image";
export * from "./domain/media/logo";
export * from "./application/media/ports";
export * from "./domain/media/rules";
export * from "./application/media/images";
export * from "./application/media/logo";
export * from "./application/media/content-images";
export * from "./contracts/rich-text";
export * from "./contracts/destination";
export * from "./contracts/event";
export * from "./domain/content/markup";
export * from "./domain/events/schedule";
export * from "./domain/geo/bounds";
export * from "./domain/geo/coordinates";
export * from "./domain/geo/proximity";
export * from "./application/content/ports";
export * from "./application/content/destinations";
export * from "./application/content/editing";
export * from "./application/content/events";
export * from "./application/content/portal";
export * from "./contracts/jobs";
export * from "./domain/jobs/failure";
export * from "./application/jobs/ports";
export * from "./application/jobs/run-job";
export * from "./application/jobs/drain";
export * from "./application/jobs/admin";
export * from "./application/media/abandoned-uploads";
export * from "./contracts/panorama";
export * from "./domain/media/panorama";
export * from "./application/media/panoramas";
export * from "./contracts/model";
export * from "./domain/media/model";
export * from "./domain/media/color";
export * from "./application/media/models";
export * from "./contracts/usage";
export * from "./application/usage/usage";
export * from "./contracts/tour";
export * from "./domain/tours/scene";
export * from "./domain/tours/hotspot";
export * from "./application/tours/tours";
export * from "./application/tours/publication";

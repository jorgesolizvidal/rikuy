/**
 * @rikuy/core — framework-free heart of the platform.
 *
 * - `domain/`      pure business rules (publication, tour graph, validity windows…)
 * - `application/` use cases: validate intent → authorize → call repository ports
 * - `contracts/`   versioned DTOs and schemas shared by web, worker and tests
 *
 * Nothing here may import Next.js, React, Supabase, AI SDKs or job runtimes
 * (enforced by ESLint). Modules are added phase by phase; see docs/roadmap.md.
 */
export {};

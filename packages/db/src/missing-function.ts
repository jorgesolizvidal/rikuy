/**
 * True when PostgREST or PostgreSQL says the function does not exist yet: the web app can
 * be deployed a few minutes before the migration that adds it (expand → migrate).
 */
export const isMissingFunction = (error: { readonly code?: string | undefined } | null) =>
  error?.code === "PGRST202" || error?.code === "42883";

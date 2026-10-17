import { z } from "zod";

/**
 * Environment contract for the platform.
 *
 * - `NEXT_PUBLIC_*` values are embedded in the browser bundle: they must never be secrets.
 * - Server values are read only on the server, at call time (not at import time), so a
 *   build without credentials still works and a missing value fails loudly where it is used.
 * - Error messages list variable NAMES only. Values are never echoed, logged or returned.
 *
 * Variables are added per roadmap phase; see `.env.example` for where each one comes from.
 */

const hostSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9.-]+(:\d+)?$/, "must be a lowercase host, optionally with a port");

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
});

export const serverEnvSchema = publicEnvSchema.extend({
  SUPABASE_SECRET_KEY: z.string().min(1),
  PLATFORM_ROOT_DOMAIN: hostSchema,
  PLATFORM_ADMIN_HOST: hostSchema,
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvValidationError extends Error {
  readonly invalidKeys: readonly string[];

  constructor(invalidKeys: readonly string[]) {
    super(
      `Invalid or missing environment variables: ${invalidKeys.join(", ")}. ` +
        "Copy .env.example to .env.local and fill them in (see the comments there).",
    );
    this.name = "EnvValidationError";
    this.invalidKeys = invalidKeys;
  }
}

function parseWith<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const keys = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "?")))];
  throw new EnvValidationError(keys.sort());
}

/** Validates the browser-safe variables. */
export function parsePublicEnv(
  source: Record<string, string | undefined> = process.env,
): PublicEnv {
  return parseWith(publicEnvSchema, source);
}

/** Validates server-only variables. Call it from server code, never from client components. */
export function parseServerEnv(
  source: Record<string, string | undefined> = process.env,
): ServerEnv {
  return parseWith(serverEnvSchema, source);
}

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

/** What the request router (proxy) needs: public Supabase access + platform hosts. No secrets. */
export const platformEnvSchema = publicEnvSchema.extend({
  PLATFORM_ROOT_DOMAIN: hostSchema,
  PLATFORM_ADMIN_HOST: hostSchema,
});

export const serverEnvSchema = platformEnvSchema.extend({
  SUPABASE_SECRET_KEY: z.string().min(1),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;
export type PlatformEnv = z.infer<typeof platformEnvSchema>;
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

/** Validates what request routing needs, without requiring any secret. */
export function parsePlatformEnv(
  source: Record<string, string | undefined> = process.env,
): PlatformEnv {
  return parseWith(platformEnvSchema, source);
}

/** Validates server-only variables. Call it from server code, never from client components. */
export function parseServerEnv(
  source: Record<string, string | undefined> = process.env,
): ServerEnv {
  return parseWith(serverEnvSchema, source);
}

/**
 * The durable job runner (P2 · Paso 2). Only its endpoint and the operator's «Procesar la
 * cola ahora» read these: the rest of the app works without them.
 * - WORKER_DATABASE_URL: PostgreSQL connection of the role rikuy_worker (Supabase pooler).
 * - JOB_RUNNER_SECRET: what the database sends to wake the runner (also in Supabase Vault).
 * - WORKER_DATABASE_ROLE: local development only, to act as rikuy_worker when connecting
 *   as `postgres` to the local stack.
 */
export const jobRunnerEnvSchema = z.object({
  WORKER_DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\/\S+$/u, "must be a postgres:// connection string"),
  JOB_RUNNER_SECRET: z.string().min(32, "must be at least 32 characters"),
  WORKER_DATABASE_ROLE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/u)
    .optional(),
});

export type JobRunnerEnv = z.infer<typeof jobRunnerEnvSchema>;

export function parseJobRunnerEnv(
  source: Record<string, string | undefined> = process.env,
): JobRunnerEnv {
  return parseWith(jobRunnerEnvSchema, {
    ...source,
    WORKER_DATABASE_ROLE: source.WORKER_DATABASE_ROLE || undefined,
  });
}

/**
 * Outgoing email of the job runner (ADR-034): invitation emails. All or nothing: with none
 * of these set, no email is sent and nothing breaks; with some set, it is a mistake.
 * - SMTP_HOST, SMTP_PORT (465 or 587; any port for a local test server)
 * - SMTP_USER, SMTP_PASSWORD (optional only for a local test server)
 * - MAIL_FROM: "Rikuy <account@example.com>", the account itself.
 */
export const mailEnvSchema = z
  .object({
    SMTP_HOST: z.string().regex(/^[a-z0-9.-]+$/u, "must be a host name"),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    MAIL_FROM: z
      .string()
      .min(3)
      .max(200)
      .regex(
        /^[^\r\n]*<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/u,
        "must be an address or Name <address>",
      ),
  })
  .refine(
    (env) =>
      ["localhost", "127.0.0.1"].includes(env.SMTP_HOST) ||
      (env.SMTP_USER !== undefined && env.SMTP_PASSWORD !== undefined),
    { path: ["SMTP_PASSWORD"], message: "a remote SMTP server needs a user and a password" },
  );

export type MailEnv = z.infer<typeof mailEnvSchema>;

const MAIL_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM"] as const;

/** The SMTP settings, or null when none is set (email is optional). */
export function parseMailEnv(
  source: Record<string, string | undefined> = process.env,
): MailEnv | null {
  const present = Object.fromEntries(
    MAIL_KEYS.map((key) => [key, source[key] || undefined] as const),
  );
  if (Object.values(present).every((value) => value === undefined)) return null;
  return parseWith(mailEnvSchema, present);
}

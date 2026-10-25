import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { EnvValidationError, parseJobRunnerEnv } from "@rikuy/config/env";
import { drainJobs, newRunnerId, type DrainReport, type JobLogger } from "@rikuy/core";
import { createPostgresJobLedger } from "@rikuy/db/worker";
import { createProcessors } from "@rikuy/worker";

import { mediaAdmin } from "./media-admin";

/**
 * The durable job runner on Vercel (ADR-019, P2 · Paso 2). The only module that opens the
 * workload's database connection (role rikuy_worker): ESLint forbids it anywhere else.
 *
 * Woken by the database (pg_net, right after a job becomes due, and every minute as a
 * safety net) through the protected endpoint /api/jobs/drain of the platform host, or by
 * an operator from /plataforma/trabajos. Every run opens its own connection and closes it.
 */

/** One structured line per event (Vercel logs). Never payloads, URLs, tokens or secrets. */
export const jsonJobLogger: JobLogger = {
  event(name, fields) {
    const level = name === "job.dead_lettered" || name === "job.lease_lost" ? "warn" : "info";
    console.log(JSON.stringify({ level, event: name, ...fields, at: new Date().toISOString() }));
  },
};

/** The runner's settings, or null when this deployment has none (nothing breaks). */
function settings() {
  try {
    return parseJobRunnerEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) return null;
    throw error;
  }
}

export function jobRunnerConfigured(): boolean {
  return settings() !== null;
}

/** Compares the request's Authorization header with the runner secret in constant time. */
export function isJobRunnerRequest(authorization: string | null): boolean {
  const secret = settings()?.JOB_RUNNER_SECRET;
  if (!secret || !authorization) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
}

export interface JobRunOptions {
  /** How long this run may keep claiming work. */
  readonly budgetMs: number;
  /** Stop claiming with less than this left (room for the longest job). */
  readonly reserveMs: number;
  readonly reason: "kick" | "operator";
}

/** A wake-up from the database: up to ~2.5 min of claiming inside a 5 min function. */
export const KICK_RUN: JobRunOptions = { budgetMs: 270_000, reserveMs: 130_000, reason: "kick" };
/** «Procesar la cola ahora»: short, so the operator sees the result on the page. */
export const OPERATOR_RUN: JobRunOptions = { budgetMs: 20_000, reserveMs: 0, reason: "operator" };

export async function runJobQueue(options: JobRunOptions): Promise<DrainReport | null> {
  const env = settings();
  if (!env) return null;
  const ledger = createPostgresJobLedger({
    url: env.WORKER_DATABASE_URL,
    ...(env.WORKER_DATABASE_ROLE ? { role: env.WORKER_DATABASE_ROLE } : {}),
    maxConnections: 3,
  });
  const runnerId = newRunnerId(`vercel:${process.env.VERCEL_REGION ?? "local"}:${options.reason}`);
  try {
    return await drainJobs({
      ledger,
      processors: createProcessors({ uploads: ledger.uploads, storage: mediaAdmin() }),
      runnerId,
      budgetMs: options.budgetMs,
      reserveMs: options.reserveMs,
      concurrency: 2,
      logger: jsonJobLogger,
    });
  } finally {
    await ledger.close();
  }
}

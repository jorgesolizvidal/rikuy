import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { EnvValidationError, parseJobRunnerEnv, parseMailEnv } from "@rikuy/config/env";
import {
  drainJobs,
  newRunnerId,
  sendDailyReport,
  type DailyReportOutcome,
  type DrainReport,
  type JobLogger,
  type JobProcessor,
  MailDeliveryError,
  type Mailer,
} from "@rikuy/core";
import {
  createGltfModelOptimizer,
  createPdfTextReader,
  createPostgresJobLedger,
  createSharpPanoramaRenderer,
  createSmtpMailer,
} from "@rikuy/db/worker";
import { createProcessors, LONG_JOB_KINDS } from "@rikuy/worker";

import { mediaAdmin } from "./media-admin";
import { platformSettings } from "./platform";

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

/** The SMTP account for invitation emails, or null (no email; ADR-034). */
function mailer(): Mailer | null {
  let mail;
  try {
    mail = parseMailEnv();
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error;
    // Half-configured: the emails fail (and show up in /plataforma/trabajos) instead of
    // vanishing; everything else keeps running.
    const keys = error.invalidKeys.join(", ");
    return {
      send: () =>
        Promise.reject(new MailDeliveryError(`SMTP settings are invalid: ${keys}`, false)),
    };
  }
  if (!mail) return null;
  return createSmtpMailer({
    host: mail.SMTP_HOST,
    port: mail.SMTP_PORT,
    from: mail.MAIL_FROM,
    ...(mail.SMTP_USER ? { user: mail.SMTP_USER } : {}),
    ...(mail.SMTP_PASSWORD ? { password: mail.SMTP_PASSWORD } : {}),
  });
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
  /** Run the kinds that take minutes (panoramas, models, documents). Only a wake-up has the time. */
  readonly longJobs: boolean;
}

/**
 * A wake-up from the database, inside a 5 min function: it claims during the first ~40 s
 * and keeps 245 s for the longest job (a panorama or a model may run 240 s).
 * The next wake-up (at most a minute later) takes whatever arrives after that.
 */
export const KICK_RUN: JobRunOptions = {
  budgetMs: 285_000,
  reserveMs: 245_000,
  reason: "kick",
  longJobs: true,
};
/** «Procesar la cola ahora»: short, so the operator sees the result on the page. */
export const OPERATOR_RUN: JobRunOptions = {
  budgetMs: 20_000,
  reserveMs: 0,
  reason: "operator",
  longJobs: false,
};

/** The processors this run may use: a short run never claims a panorama. */
export function processorsFor(
  options: Pick<JobRunOptions, "longJobs">,
  processors: readonly JobProcessor[],
): readonly JobProcessor[] {
  return options.longJobs
    ? processors
    : processors.filter((processor) => !LONG_JOB_KINDS.includes(processor.kind));
}

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
      processors: processorsFor(
        options,
        createProcessors({
          uploads: ledger.uploads,
          storage: mediaAdmin(),
          panoramas: ledger.panoramas,
          renderer: createSharpPanoramaRenderer(),
          models: ledger.models,
          optimizer: createGltfModelOptimizer(),
          media: mediaAdmin(),
          invitations: ledger.invitations,
          mailer: mailer(),
          adminOrigin: platformSettings().adminOrigin,
          unusedMedia: ledger.unusedMedia,
          folders: mediaAdmin(),
          documents: ledger.documents,
          pdf: createPdfTextReader(),
          knowledge: ledger.knowledge,
        }),
      ),
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

/**
 * The daily report (ADR-035): the database asks for it once a day through the same wake-up
 * (reason "daily"). Emails the operators only when something needs a look.
 */
export async function runDailyReport(): Promise<DailyReportOutcome | null> {
  const env = settings();
  if (!env) return null;
  const ledger = createPostgresJobLedger({
    url: env.WORKER_DATABASE_URL,
    ...(env.WORKER_DATABASE_ROLE ? { role: env.WORKER_DATABASE_ROLE } : {}),
    maxConnections: 1,
  });
  try {
    const outcome = await sendDailyReport({
      reader: ledger,
      mailer: mailer(),
      adminOrigin: platformSettings().adminOrigin,
    });
    console.log(
      JSON.stringify({
        level: outcome.alerts.length > 0 ? "warn" : "info",
        event: "operations.daily_report",
        alerts: outcome.alerts.map((alert) => alert.code).join(",") || "none",
        mail: outcome.mail,
        sent: outcome.sent,
        failed: outcome.failed,
        at: new Date().toISOString(),
      }),
    );
    return outcome;
  } finally {
    await ledger.close();
  }
}

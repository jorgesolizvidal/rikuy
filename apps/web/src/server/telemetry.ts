import "server-only";

import { EnvValidationError, parseJobRunnerEnv } from "@rikuy/config/env";
import {
  describeServerError,
  type MeasuredRoute,
  type ServerErrorInput,
  type Telemetry,
  type VisitRecord,
} from "@rikuy/core";
import { createPostgresTelemetry } from "@rikuy/db/worker";

/**
 * Telemetry of the web app (ADR-044): server errors (from instrumentation's
 * onRequestError), the latency of the routes the server answers on every visitor request
 * and the anonymous visit counts (ADR-051). Written with the workload's connection (rikuy_worker), one small connection per
 * instance. Without WORKER_DATABASE_URL nothing is recorded and nothing breaks. Never
 * throws: telemetry must not turn a working response into an error.
 */

let instance: Telemetry | null | undefined;

function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ level: "warn", event, ...fields, at: new Date().toISOString() }));
}

export function telemetry(): Telemetry | null {
  if (instance !== undefined) return instance;
  try {
    const env = parseJobRunnerEnv();
    instance = createPostgresTelemetry({
      url: env.WORKER_DATABASE_URL,
      ...(env.WORKER_DATABASE_ROLE ? { role: env.WORKER_DATABASE_ROLE } : {}),
      // Only the kind of failure: never values, URLs or messages that could echo data.
      onFailure: (what, error) =>
        log("telemetry.write_failed", {
          what,
          error: error instanceof Error ? error.name : "unknown",
        }),
    });
  } catch (error) {
    if (!(error instanceof EnvValidationError)) log("telemetry.setup_failed", {});
    instance = null;
  }
  return instance;
}

/** onRequestError: what is recorded is decided by describeServerError (no body, IP, email). */
export async function recordServerError(input: ServerErrorInput): Promise<void> {
  const sink = telemetry();
  if (sink === null) return;
  try {
    await sink.recordError(describeServerError(input));
  } catch {
    // Never let telemetry fail a request.
  }
}

/** Records how long a measured route took; call it inside after(), once responded. */
export async function recordRouteLatency(
  tenantId: string,
  route: MeasuredRoute,
  startedAt: number,
  status: number,
): Promise<void> {
  const sink = telemetry();
  if (sink === null) return;
  await sink.recordLatency({ tenantId, route, ms: performance.now() - startedAt, status });
}

/** An anonymous visit count (ADR-051); call it inside after(), once responded. */
export async function recordVisit(record: VisitRecord): Promise<void> {
  const sink = telemetry();
  if (sink === null) return;
  await sink.recordVisit(record);
}

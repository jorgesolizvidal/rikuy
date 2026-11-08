import type { RequestErrorRecord, RouteLatencyRecord, Telemetry } from "@rikuy/core";
import postgres from "postgres";

/**
 * Telemetry of the web app (ADR-044): server errors and the latency of the measured routes,
 * written through worker_api with the workload's own role (rikuy_worker). Never a visitor's
 * or a staff member's session, never the secret key. One small connection per instance,
 * closed when idle; a write that fails is reported to `onFailure` and never thrown.
 */
export interface PostgresTelemetryOptions {
  readonly url: string;
  /** Local only: the connection is made as `postgres`; in the cloud the URL's user is the worker. */
  readonly role?: string;
  readonly onFailure?: (what: "error" | "latency", error: unknown) => void;
}

export interface PostgresTelemetry extends Telemetry {
  close(): Promise<void>;
}

export function createPostgresTelemetry(options: PostgresTelemetryOptions): PostgresTelemetry {
  const host = new URL(options.url.replace(/^postgres(ql)?:/u, "http:")).hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "";
  const sql = postgres(options.url, {
    ssl: local ? false : "require",
    max: 1,
    prepare: false,
    idle_timeout: 10,
    connect_timeout: 5,
    ...(options.role ? { connection: { role: options.role } } : {}),
    onnotice: () => undefined,
  });
  const fail = options.onFailure ?? (() => undefined);

  return {
    async recordError(record: RequestErrorRecord) {
      try {
        await sql`
          select worker_api.record_request_error(
            ${record.requestId}::uuid, ${record.digest}, ${record.surface}, ${record.tenantId}::uuid,
            ${record.slug}, ${record.route}, ${record.method}, ${record.kind}, ${record.message}
          )
        `;
      } catch (error) {
        fail("error", error);
      }
    },
    async recordLatency(record: RouteLatencyRecord) {
      try {
        await sql`
          select worker_api.record_route_latency(
            ${record.tenantId}::uuid, ${record.route}, ${Math.round(record.ms)}::integer,
            ${record.status}::integer
          )
        `;
      } catch (error) {
        fail("latency", error);
      }
    },
    async close() {
      await sql.end({ timeout: 2 });
    },
  };
}

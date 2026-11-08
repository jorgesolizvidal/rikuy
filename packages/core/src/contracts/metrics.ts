import { z } from "zod";

/**
 * Metrics per municipality for the operator (ADR-044). Every figure the panel shows comes
 * with its source and its period; these shapes are what the database's readings return.
 */

/** Routes the server answers on every visitor request, timed and summed up per hour. */
export const MEASURED_ROUTES = [
  "assistant",
  "dictation",
  "assistant_places",
  "map_places",
  "tour_data",
] as const;
export type MeasuredRoute = (typeof MEASURED_ROUTES)[number];

export const ERROR_SURFACES = ["portal", "admin", "platform"] as const;
export type ErrorSurface = (typeof ERROR_SURFACES)[number];

export const PROBE_TARGETS = ["home", "map", "media"] as const;
export type ProbeTarget = (typeof PROBE_TARGETS)[number];

export const PUBLICATION_PROBLEMS = [
  "photo_missing",
  "tour_file_missing",
  "tour_photo_missing",
  "logo_missing",
  "not_indexed",
] as const;
export type PublicationProblemKind = (typeof PUBLICATION_PROBLEMS)[number];

/** Upper bound of the last bucket: «more than 6.4 s». */
export const LATENCY_OVERFLOW_MS = 6401;

const count = z.coerce.number().int().min(0);
const ms = z.coerce.number().int().min(0).nullable();

export const metricsOverviewSchema = z.object({
  generatedAt: z.string(),
  platformErrors: z.object({ last24h: count, last7d: count }),
  tenants: z.array(
    z.object({
      tenantId: z.uuid(),
      slug: z.string(),
      displayName: z.string(),
      status: z.enum(["provisioning", "active", "suspended"]),
      errors24h: count,
      requests24h: count,
      p95Ms24h: ms,
      jobsFailed7d: count,
      jobsWaiting: count,
      aiCalls7d: count,
      aiCostUsd7d: z.coerce.number().min(0),
      probe: z
        .object({ probedAt: z.string(), status: z.number().int().nullable(), ttfbMs: ms })
        .nullable(),
      check: z.object({ checkedAt: z.string(), problems: count }).nullable(),
    }),
  ),
});
export type MetricsOverview = z.infer<typeof metricsOverviewSchema>;
export type MetricsOverviewTenant = MetricsOverview["tenants"][number];

const period = z.enum(["24h", "7d"]);

export const tenantMetricsSchema = z.object({
  generatedAt: z.string(),
  errors: z.object({
    last24h: count,
    last7d: count,
    byRoute: z.array(
      z.object({ route: z.string(), surface: z.enum(ERROR_SURFACES), count: count }),
    ),
  }),
  routes: z.array(
    z.object({
      // A route a newer database knows is shown by its name; never a crash.
      route: z.string(),
      period,
      requests: count,
      errors: count,
      avgMs: ms,
      p50Ms: ms,
      p95Ms: ms,
    }),
  ),
  probes: z.array(
    z.object({
      target: z.enum(PROBE_TARGETS),
      path: z.string(),
      probedAt: z.string(),
      status: z.number().int().nullable(),
      ttfbMs: ms,
      totalMs: ms,
      bytes: z.number().int().nullable(),
      cache: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
  jobs: z.array(
    z.object({
      kind: z.string(),
      created: count,
      succeeded: count,
      deadLetter: count,
      pending: count,
      running: count,
      p95AttemptMs: ms,
    }),
  ),
  jobsWaiting: z.object({
    ready: count,
    oldestWaitSeconds: z.number().int().nullable(),
    deadLetterOpen: count,
  }),
  ai: z.array(
    z.object({
      period,
      model: z.string(),
      calls: count,
      failed: count,
      inputTokens: count,
      outputTokens: count,
      audioSeconds: count,
      costUsd: z.coerce.number().min(0),
      unpriced: count,
      priceVersions: z.array(z.string()),
      p95LatencyMs: ms,
    }),
  ),
  aiRejected7d: count,
  check: z
    .object({
      checkedAt: z.string(),
      trigger: z.enum(["daily", "manual"]),
      checked: z.object({ contents: count, photos: count, tours: count, logo: count }),
      problems: z.array(
        z.object({
          kind: z.string(),
          title: z.string().nullable(),
          detail: z.string().nullable(),
        }),
      ),
      problemCount: count,
      durationMs: count,
    })
    .nullable(),
});
export type TenantMetrics = z.infer<typeof tenantMetricsSchema>;

export interface RequestErrorRow {
  readonly id: string;
  readonly occurredAt: string;
  readonly surface: ErrorSurface;
  readonly route: string;
  readonly method: string;
  readonly kind: string;
  readonly message: string;
  readonly requestId: string;
  readonly digest: string | null;
}

/** What the server records about one of its errors (no body, headers, IP or email). */
export interface RequestErrorRecord {
  readonly requestId: string | null;
  readonly digest: string | null;
  readonly surface: ErrorSurface;
  readonly tenantId: string | null;
  readonly slug: string | null;
  readonly route: string;
  readonly method: string;
  readonly kind: string;
  readonly message: string;
}

export interface RouteLatencyRecord {
  readonly tenantId: string;
  readonly route: MeasuredRoute;
  readonly ms: number;
  readonly status: number;
}

/** One timed request of the daily probe; a failure has no status and says why. */
export interface PortalProbeResult {
  readonly target: ProbeTarget;
  readonly path: string;
  readonly status: number | null;
  readonly ttfbMs: number | null;
  readonly totalMs: number | null;
  readonly bytes: number | null;
  readonly cache: string | null;
  readonly error: string | null;
}

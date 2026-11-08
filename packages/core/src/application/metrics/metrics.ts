import type {
  MetricsOverview,
  PortalProbeResult,
  ProbeTarget,
  RequestErrorRecord,
  RequestErrorRow,
  RouteLatencyRecord,
  TenantMetrics,
} from "../../contracts/metrics";
import type { JobLease } from "../jobs/ports";
import type { PlatformRepository } from "../platform/ports";

/**
 * Metrics per municipality (ADR-044). The operator, with a second factor, reads them; the
 * database checks it again. Telemetry (errors and latency) is written by the platform's own
 * connection, never by a visitor's or a staff member's session.
 */

export interface MetricsRepository {
  overview(): Promise<MetricsOverview>;
  /** Null: no such municipality. */
  tenant(tenantId: string): Promise<TenantMetrics | null>;
  /** Null tenant: the platform's errors (no municipality). */
  errors(tenantId: string | null, search: string | null): Promise<RequestErrorRow[]>;
  /** «Revisar ahora». */
  checkPublication(tenantId: string): Promise<"checked" | "not_found" | "forbidden">;
}

/** Fire-and-forget writes: a failure is logged by the adapter, never thrown to a visitor. */
export interface Telemetry {
  recordError(record: RequestErrorRecord): Promise<void>;
  recordLatency(record: RouteLatencyRecord): Promise<void>;
}

async function operator(platform: PlatformRepository): Promise<boolean> {
  return (await platform.operatorAccess()) === "ok";
}

export async function loadMetricsOverview(
  platform: PlatformRepository,
  metrics: MetricsRepository,
): Promise<MetricsOverview | null> {
  return (await operator(platform)) ? metrics.overview() : null;
}

export type TenantMetricsView =
  | { readonly status: "forbidden" }
  | { readonly status: "not_found" }
  | {
      readonly status: "found";
      readonly tenant: MetricsOverview["tenants"][number];
      readonly metrics: TenantMetrics;
      readonly errors: readonly RequestErrorRow[];
      readonly search: string | null;
    };

const SEARCH = /^[A-Za-z0-9_-]{1,64}$/u;

/** A request ID or a reference code (digest) to look for; anything else is ignored. */
export function normalizeErrorSearch(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return SEARCH.test(trimmed) ? trimmed : null;
}

/** One municipality by its slug, with its latest errors (optionally one of them). */
export async function loadTenantMetrics(
  platform: PlatformRepository,
  metrics: MetricsRepository,
  slug: string,
  search: unknown,
): Promise<TenantMetricsView> {
  if (!(await operator(platform))) return { status: "forbidden" };
  const overview = await metrics.overview();
  const tenant = overview.tenants.find((entry) => entry.slug === slug);
  if (!tenant) return { status: "not_found" };
  const query = normalizeErrorSearch(search);
  const [detail, errors] = await Promise.all([
    metrics.tenant(tenant.tenantId),
    metrics.errors(tenant.tenantId, query),
  ]);
  if (detail === null) return { status: "not_found" };
  return { status: "found", tenant, metrics: detail, errors, search: query };
}

/** The platform's own errors (no municipality). */
export async function loadPlatformErrors(
  platform: PlatformRepository,
  metrics: MetricsRepository,
  search: unknown,
): Promise<RequestErrorRow[] | null> {
  if (!(await operator(platform))) return null;
  return metrics.errors(null, normalizeErrorSearch(search));
}

export async function checkPublicationNow(
  platform: PlatformRepository,
  metrics: MetricsRepository,
  tenantId: unknown,
): Promise<"checked" | "not_found" | "forbidden"> {
  if (!(await operator(platform))) return "forbidden";
  if (typeof tenantId !== "string" || !/^[0-9a-f-]{36}$/u.test(tenantId)) return "not_found";
  return metrics.checkPublication(tenantId);
}

// ── The daily probe of a portal (metrics.probe_portal) ────────────────────────

export interface PortalProbeTarget {
  readonly host: string;
  /** The municipality's latest public image, `{tenant}/…`; null when it has none. */
  readonly mediaPath: string | null;
}

export interface PortalProbeStore {
  /** Null: the municipality is not online (nothing to probe). */
  target(lease: JobLease): Promise<PortalProbeTarget | null | "lease_lost">;
  record(
    lease: JobLease,
    results: readonly PortalProbeResult[],
  ): Promise<"recorded" | "lease_lost">;
}

export interface TimedResponse {
  readonly status: number;
  readonly ttfbMs: number;
  readonly totalMs: number;
  readonly bytes: number;
  /** x-vercel-cache (HIT, MISS, STALE…), or null. */
  readonly cache: string | null;
}

/** Times one GET: until the headers and until the last byte. Throws on network errors. */
export type TimedFetch = (url: string) => Promise<TimedResponse>;

export interface PortalProbePlan {
  readonly target: ProbeTarget;
  readonly url: string;
  /** What is recorded: the portal path, or `media-public/{path}`. Never a query string. */
  readonly path: string;
}

/** The home (cached), /mapa (reads the database) and one public image, if any. */
export function planPortalProbe(
  target: PortalProbeTarget,
  origins: { readonly portalOrigin: (host: string) => string; readonly publicMediaBase: string },
): PortalProbePlan[] {
  const origin = origins.portalOrigin(target.host);
  const plan: PortalProbePlan[] = [
    { target: "home", url: `${origin}/`, path: "/" },
    { target: "map", url: `${origin}/mapa`, path: "/mapa" },
  ];
  if (target.mediaPath) {
    plan.push({
      target: "media",
      url: `${origins.publicMediaBase.replace(/\/$/u, "")}/storage/v1/object/public/media-public/${target.mediaPath}`,
      path: `media-public/${target.mediaPath}`.slice(0, 300),
    });
  }
  return plan;
}

/** Runs the plan one request at a time; a failure is recorded with its reason, never thrown. */
export async function runPortalProbe(
  plan: readonly PortalProbePlan[],
  fetchTimed: TimedFetch,
): Promise<PortalProbeResult[]> {
  const results: PortalProbeResult[] = [];
  for (const step of plan) {
    try {
      const response = await fetchTimed(step.url);
      results.push({
        target: step.target,
        path: step.path,
        status: response.status,
        ttfbMs: Math.round(response.ttfbMs),
        totalMs: Math.round(response.totalMs),
        bytes: response.bytes,
        cache: response.cache && /^[A-Z_]{1,20}$/u.test(response.cache) ? response.cache : null,
        error: null,
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_error";
      results.push({
        target: step.target,
        path: step.path,
        status: null,
        ttfbMs: null,
        totalMs: null,
        bytes: null,
        cache: null,
        error: reason,
      });
    }
  }
  return results;
}

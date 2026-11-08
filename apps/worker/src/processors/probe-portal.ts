import {
  JOB_KINDS,
  permanentFailure,
  planPortalProbe,
  probePortalPayloadSchema,
  runPortalProbe,
  transientFailure,
  type JobProcessor,
  type PortalProbeStore,
  type TimedFetch,
} from "@rikuy/core";

export interface ProbePortalDeps {
  readonly probes: PortalProbeStore;
  readonly portalProbe: {
    /** `https://{host}` (or `http://{host}:port` locally). */
    readonly portalOrigin: (host: string) => string;
    /** The Supabase project URL: public files are under /storage/v1/object/public/. */
    readonly publicMediaBase: string;
    readonly fetchTimed?: TimedFetch;
  };
}

/** One GET with a 15 s limit: the time until the headers and until the last byte. */
export function createTimedFetch(fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): TimedFetch {
  return async (url) => {
    const started = performance.now();
    const response = await fetchImpl(url, {
      headers: { "user-agent": "RikuyProbe/1 (+ADR-044)", "cache-control": "no-cache" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ttfbMs = performance.now() - started;
    const body = await response.arrayBuffer();
    return {
      status: response.status,
      ttfbMs,
      totalMs: performance.now() - started,
      bytes: body.byteLength,
      cache: response.headers.get("x-vercel-cache")?.toUpperCase() ?? null,
    };
  };
}

/**
 * metrics.probe_portal (ADR-044): once a day, from the function's region, times the home
 * (cached), /mapa (reads the database) and the municipality's latest public image. A
 * request that fails is recorded with its reason; only losing the lease is retried.
 */
export function createProbePortalProcessor(deps: ProbePortalDeps): JobProcessor {
  const fetchTimed = deps.portalProbe.fetchTimed ?? createTimedFetch();
  return {
    kind: JOB_KINDS.probePortal,
    schemaVersions: [1],
    async run({ job }) {
      if (!probePortalPayloadSchema.safeParse(job.payload).success) {
        throw permanentFailure("invalid_payload", "The job payload is not valid.");
      }
      const lease = { jobId: job.jobId, fencingToken: job.fencingToken };
      const target = await deps.probes.target(lease);
      if (target === "lease_lost") throw transientFailure("lease_lost", "The lease was lost.");
      if (target === null) return { result: { outcome: "not_online" } };

      const results = await runPortalProbe(planPortalProbe(target, deps.portalProbe), fetchTimed);
      const recorded = await deps.probes.record(lease, results);
      if (recorded === "lease_lost") throw transientFailure("lease_lost", "The lease was lost.");
      return {
        result: {
          outcome: "probed",
          ok: results.filter((entry) => entry.status !== null && entry.status < 400).length,
          total: results.length,
        },
      };
    },
  };
}

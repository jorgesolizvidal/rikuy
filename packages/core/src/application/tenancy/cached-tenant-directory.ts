import type { PortalTenant } from "../../contracts/tenant";
import type { TenantDirectory } from "./resolve-portal-tenant";

export interface TenantDirectoryCacheOptions {
  /** How long a resolved tenant is reused (ADR-015 proposes 60 s). */
  readonly positiveTtlMs?: number;
  /** How long an unknown host is remembered (ADR-015 proposes 10 s). */
  readonly negativeTtlMs?: number;
  /** Upper bound of cached hosts; oldest entries are evicted first. */
  readonly maxEntries?: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

interface Entry {
  readonly value: PortalTenant | null;
  readonly expiresAt: number;
}

/**
 * Best-effort, per-instance cache in front of the registry. Keyed by exact hostname,
 * so two tenants can never share an entry. Errors are never cached, and concurrent
 * lookups of the same host share one registry call.
 */
export function createCachedTenantDirectory(
  inner: TenantDirectory,
  options: TenantDirectoryCacheOptions = {},
): TenantDirectory & { clear(): void } {
  const positiveTtlMs = options.positiveTtlMs ?? 60_000;
  const negativeTtlMs = options.negativeTtlMs ?? 10_000;
  const maxEntries = options.maxEntries ?? 1_000;
  const now = options.now ?? Date.now;

  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<PortalTenant | null>>();

  function remember(hostname: string, value: PortalTenant | null): void {
    entries.delete(hostname);
    if (entries.size >= maxEntries) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
    entries.set(hostname, {
      value,
      expiresAt: now() + (value === null ? negativeTtlMs : positiveTtlMs),
    });
  }

  return {
    async findByHost(hostname) {
      const cached = entries.get(hostname);
      if (cached !== undefined && cached.expiresAt > now()) return cached.value;

      const pending = inFlight.get(hostname);
      if (pending !== undefined) return pending;

      const lookup = inner
        .findByHost(hostname)
        .then((value) => {
          remember(hostname, value);
          return value;
        })
        .finally(() => {
          inFlight.delete(hostname);
        });

      inFlight.set(hostname, lookup);
      return lookup;
    },
    clear() {
      entries.clear();
    },
  };
}

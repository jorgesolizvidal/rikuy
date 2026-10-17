/**
 * Host normalization and classification (ADR-015).
 *
 * The tenant of a request is derived ONLY from the Host header received from the
 * trusted ingress. Values such as X-Forwarded-Host or X-Tenant-* are never consulted.
 * This module is pure: it decides which surface a host belongs to, it never guesses a
 * tenant. Unknown hosts are resolved later against the domain registry and may 404.
 */

export interface PlatformHosts {
  /** Platform apex, e.g. `rikuy.app`, or `localhost` in local development. */
  readonly rootDomain: string;
  /** Central admin host, e.g. `app.rikuy.app` or `app.localhost:3000` locally. */
  readonly adminHost: string;
}

export interface NormalizedHost {
  /** Lowercase ASCII (IDNA) hostname without port or trailing dot. */
  readonly hostname: string;
  /** Explicit port, only when ports are allowed (local development). */
  readonly port: string | null;
}

export type InvalidHostReason = "missing" | "malformed" | "port_not_allowed";

export type NormalizeHostResult =
  | { readonly ok: true; readonly host: NormalizedHost }
  | { readonly ok: false; readonly reason: InvalidHostReason };

export type HostClassification =
  | { readonly kind: "platform" }
  | { readonly kind: "admin" }
  | { readonly kind: "portal"; readonly hostname: string }
  | { readonly kind: "invalid"; readonly reason: InvalidHostReason };

const MAX_HOST_LENGTH = 253;
// Characters that could smuggle userinfo, paths, IPv6 literals or multiple values.
const FORBIDDEN_CHARACTERS = /[\s,/\\@?#[\]%"'<>`{}|^]/u;
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_PATTERN = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/** Ports are only meaningful in local development, where the platform runs on `localhost`. */
export function portsAllowedFor(hosts: PlatformHosts): boolean {
  return hosts.rootDomain === "localhost";
}

export function normalizeHost(
  raw: string | null | undefined,
  options: { readonly allowPort: boolean },
): NormalizeHostResult {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return { ok: false, reason: "missing" };
  }

  const candidate = raw.trim();
  if (candidate.length > MAX_HOST_LENGTH + 6 || FORBIDDEN_CHARACTERS.test(candidate)) {
    return { ok: false, reason: "malformed" };
  }

  let url: URL;
  try {
    url = new URL(`http://${candidate}`);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // URL parsing applies IDNA (punycode) and lowercasing.
  const hostname = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    hostname.length === 0 ||
    hostname.length > MAX_HOST_LENGTH ||
    !HOSTNAME_PATTERN.test(hostname)
  ) {
    return { ok: false, reason: "malformed" };
  }

  const port = url.port === "" ? null : url.port;
  if (port !== null && !options.allowPort) {
    return { ok: false, reason: "port_not_allowed" };
  }

  return { ok: true, host: { hostname, port } };
}

function withPort(host: NormalizedHost): string {
  return host.port === null ? host.hostname : `${host.hostname}:${host.port}`;
}

/**
 * Decides which surface serves a request:
 * - `admin`    → the central admin host (exact match, including port in development);
 * - `platform` → the platform apex (product site);
 * - `portal`   → any other well-formed host, to be looked up in the domain registry;
 * - `invalid`  → missing/malformed host or a port where ports are not allowed.
 */
export function classifyHost(
  rawHostHeader: string | null | undefined,
  hosts: PlatformHosts,
): HostClassification {
  const allowPort = portsAllowedFor(hosts);
  const request = normalizeHost(rawHostHeader, { allowPort });
  if (!request.ok) return { kind: "invalid", reason: request.reason };

  const admin = normalizeHost(hosts.adminHost, { allowPort });
  const root = normalizeHost(hosts.rootDomain, { allowPort: false });
  if (!admin.ok || !root.ok) {
    throw new Error(
      "Platform host configuration is invalid (PLATFORM_ADMIN_HOST / PLATFORM_ROOT_DOMAIN).",
    );
  }

  if (withPort(request.host) === withPort(admin.host)) return { kind: "admin" };
  if (request.host.hostname === root.host.hostname) return { kind: "platform" };
  return { kind: "portal", hostname: request.host.hostname };
}

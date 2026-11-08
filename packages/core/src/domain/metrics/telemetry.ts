import { decodeTenantContext } from "../../contracts/tenant";
import type { ErrorSurface, RequestErrorRecord } from "../../contracts/metrics";

/**
 * Turns a server error into what gets recorded (ADR-044): the surface, the municipality,
 * the route PATTERN (never the real address), the method, the request ID set by the proxy,
 * Next's digest and the error's type and message, cut at the query string. No body,
 * headers, IP, cookies or email ever leave this function.
 */

/** Request headers the proxy sets (incoming ones with this prefix are discarded). */
export const REQUEST_ID_HEADER = "x-rikuy-request-id";
export const TENANT_CONTEXT_HEADER_NAME = "x-rikuy-tenant-context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ROUTE = /^\/[A-Za-z0-9_./[\]-]{0,199}$/u;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export interface ServerErrorInput {
  /** The request path Next reports: the address the browser asked for (/mapa, /o/{slug}/…). */
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The route pattern, e.g. /portal/[host]/destinos/[slug]: it tells the surface apart. */
  readonly routePath?: string | undefined;
  readonly error: unknown;
}

function header(headers: ServerErrorInput["headers"], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Query strings (signed URLs, tokens) never reach the record; at most 300 characters. */
export function cleanErrorMessage(message: string): string {
  return message.replace(/\?\S*/gu, "?…").replace(/\s+/gu, " ").trim().slice(0, 300);
}

function surfaceOf(path: string): ErrorSurface {
  if (path.startsWith("/portal/")) return "portal";
  if (path === "/platform" || path.startsWith("/platform/")) return "platform";
  return "admin";
}

/** The panel's municipality, from /admin/o/{slug}/… or /o/{slug}/…. */
function panelSlug(path: string): string | null {
  const match = /^(?:\/admin)?\/o\/([^/?#]+)/u.exec(path);
  const slug = match?.[1] ? decodeURIComponent(match[1]) : null;
  return slug && SLUG.test(slug) ? slug : null;
}

export function describeServerError(input: ServerErrorInput): RequestErrorRecord {
  const path = input.path.split("?")[0] ?? "/";
  // The browser's address is not rewritten (/mapa, /o/{slug}); the route pattern is
  // (/portal/[host]/mapa, /admin/o/[slug]), so it decides the surface when there is one.
  const surface = surfaceOf(input.routePath ?? path);
  const requestId = header(input.headers, REQUEST_ID_HEADER);
  const error = input.error instanceof Error ? input.error : null;
  const digest =
    input.error && typeof input.error === "object" && "digest" in input.error
      ? String((input.error as { digest: unknown }).digest)
      : null;
  const tenant =
    surface === "portal"
      ? decodeTenantContext(header(input.headers, TENANT_CONTEXT_HEADER_NAME) ?? null)
      : null;
  const route = input.routePath && ROUTE.test(input.routePath) ? input.routePath : "/";

  return {
    requestId: requestId && UUID.test(requestId) ? requestId : null,
    digest: digest && /^[A-Za-z0-9_-]{1,64}$/u.test(digest) ? digest : null,
    surface,
    tenantId: tenant?.tenant.tenantId ?? null,
    slug: surface === "admin" ? panelSlug(path) : null,
    route,
    method: /^[A-Za-z]{3,7}$/u.test(input.method) ? input.method.toUpperCase() : "GET",
    kind: error && /^[A-Za-z][A-Za-z0-9_.]{0,59}$/u.test(error.name) ? error.name : "Error",
    message: cleanErrorMessage(error?.message ?? String(input.error ?? "")),
  };
}

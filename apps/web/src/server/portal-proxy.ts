import {
  classifyHost,
  encodeTenantContext,
  resolvePortalTenant,
  type PlatformHosts,
  type TenantDirectory,
} from "@rikuy/core";
import { NextResponse, type NextRequest } from "next/server";

import { TENANT_CONTEXT_HEADER, stripInternalHeaders } from "./internal-headers";

export interface PortalProxyDeps {
  readonly hosts: PlatformHosts;
  readonly directory: TenantDirectory;
  /** Session refresh for the admin host only; portal hosts never touch auth cookies. */
  readonly refreshAdminSession?: (
    request: NextRequest,
    respond: (headers: Headers) => NextResponse,
  ) => Promise<NextResponse>;
}

/** Internal route prefixes. Every request is re-prefixed, so they cannot be reached directly. */
export const ROUTES = { platform: "/platform", admin: "/admin", portal: "/portal" } as const;

function statusPage(
  status: number,
  title: string,
  message: string,
  extra: HeadersInit = {},
): NextResponse {
  const body = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;line-height:1.5"><h1>${title}</h1><p>${message}</p></body></html>`;
  return new NextResponse(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      ...extra,
    },
  });
}

function rewrite(request: NextRequest, prefix: string, headers: Headers): NextResponse {
  const { pathname, search } = request.nextUrl;
  const target = new URL(`${prefix}${pathname === "/" ? "" : pathname}${search}`, request.url);
  return NextResponse.rewrite(target, { request: { headers } });
}

const ADMIN_HEADERS = {
  "x-robots-tag": "noindex, nofollow",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};

/**
 * Routes every request by its Host header (ADR-015):
 * admin host → /admin · platform apex → /platform · portal host → /portal/{host}
 * Unknown portal hosts get 404, an unreachable registry 503, aliases a 308 to the
 * canonical host. X-Forwarded-Host and X-Tenant-* headers are never trusted.
 */
export function createPortalProxy(deps: PortalProxyDeps) {
  return async function portalProxy(request: NextRequest): Promise<NextResponse> {
    const headers = stripInternalHeaders(request.headers);
    const surface = classifyHost(request.headers.get("host"), deps.hosts);

    switch (surface.kind) {
      case "invalid":
        return statusPage(400, "Solicitud no válida", "El dominio de la solicitud no es válido.");
      case "admin": {
        const respond = (forwarded: Headers) => {
          const response = rewrite(request, ROUTES.admin, forwarded);
          for (const [key, value] of Object.entries(ADMIN_HEADERS))
            response.headers.set(key, value);
          return response;
        };
        return deps.refreshAdminSession
          ? deps.refreshAdminSession(request, respond)
          : respond(headers);
      }
      case "platform":
        return rewrite(request, ROUTES.platform, headers);
      case "portal": {
        const resolution = await resolvePortalTenant(surface.hostname, deps.directory);

        if (resolution.status === "not_found") {
          return statusPage(
            404,
            "Sitio no encontrado",
            "Este dominio no corresponde a ningún portal activo.",
          );
        }
        if (resolution.status === "unavailable") {
          return statusPage(
            503,
            "Servicio no disponible",
            "No pudimos cargar este portal en este momento. Inténtalo de nuevo en unos segundos.",
            { "retry-after": "30" },
          );
        }
        if (resolution.status === "redirect") {
          const { protocol, port, pathname, search } = request.nextUrl;
          const location = `${protocol}//${resolution.canonicalHost}${port ? `:${port}` : ""}${pathname}${search}`;
          return NextResponse.redirect(location, 308);
        }

        headers.set(TENANT_CONTEXT_HEADER, encodeTenantContext(resolution.context));
        return rewrite(
          request,
          `${ROUTES.portal}/${encodeURIComponent(surface.hostname)}`,
          headers,
        );
      }
    }
  };
}

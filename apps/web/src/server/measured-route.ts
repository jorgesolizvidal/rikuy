import "server-only";

import { decodeTenantContext, type MeasuredRoute } from "@rikuy/core";
import { after } from "next/server";

import { TENANT_CONTEXT_HEADER } from "./internal-headers";
import { recordRouteLatency } from "./telemetry";

/**
 * Times a route handler of the portal (ADR-044) and records it after responding, per
 * municipality, hour and route. The municipality comes from the proxy's tenant context
 * (an incoming header with that name is always discarded), so no extra query is made. A
 * handler that throws is recorded as a 500 and rethrown (onRequestError records the error).
 */
export function measured<Context>(
  route: MeasuredRoute,
  handler: (request: Request, context: Context) => Promise<Response>,
): (request: Request, context: Context) => Promise<Response> {
  return async (request, context) => {
    const startedAt = performance.now();
    let status = 500;
    try {
      const response = await handler(request, context);
      status = response.status;
      return response;
    } finally {
      const tenantId = decodeTenantContext(request.headers.get(TENANT_CONTEXT_HEADER))?.tenant
        .tenantId;
      if (tenantId) {
        after(() => recordRouteLatency(tenantId, route, startedAt, status));
      }
    }
  };
}

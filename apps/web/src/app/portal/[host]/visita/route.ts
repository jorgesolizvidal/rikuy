import { decodeTenantContext, visitRecordFrom } from "@rikuy/core";
import { after } from "next/server";

import { TENANT_CONTEXT_HEADER } from "@/server/internal-headers";
import { visitorKey } from "@/server/portal-request";
import { recordVisit } from "@/server/telemetry";

const MAX_BODY = 1024;
const NO_CONTENT = { status: 204, headers: { "cache-control": "no-store" } } as const;

/**
 * POST /visita on the portal's host: an anonymous visit count sent by the visitor's browser
 * (ADR-051). The municipality comes from the host (the proxy's context), never from the body;
 * only beacons of this same portal count, robots never. It answers at once with 204, also when
 * nothing is counted, and writes after responding: a page never waits for it.
 */
export async function POST(request: Request) {
  const tenant = decodeTenantContext(request.headers.get(TENANT_CONTEXT_HEADER))?.tenant;
  if (!tenant) return new Response(null, { status: 404, headers: NO_CONTENT.headers });
  if (!sameSite(request)) return new Response(null, { status: 403, headers: NO_CONTENT.headers });

  const text = await request.text();
  if (text.length > MAX_BODY) return new Response(null, NO_CONTENT);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, NO_CONTENT);
  }

  const record = visitRecordFrom({
    tenantId: tenant.tenantId,
    body,
    userAgent: request.headers.get("user-agent"),
    address: visitorKey(request),
    country: request.headers.get("x-vercel-ip-country"),
    city: request.headers.get("x-vercel-ip-city"),
  });
  if (record) after(() => recordVisit(record));
  return new Response(null, NO_CONTENT);
}

/** Origin of this portal; or, for a browser that sends no Origin, Sec-Fetch-Site. */
function sameSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin !== null) {
    try {
      return host !== null && new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

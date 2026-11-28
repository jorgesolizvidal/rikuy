import { after } from "next/server";

import { parseAssistantAction } from "@rikuy/core";

import { recordAssistantAction } from "@/server/ai-gateway";
import { fromSamePortal, visitorKey } from "@/server/portal-request";
import { portalViewWith } from "@/server/portal-view";

interface ActionContext {
  readonly params: Promise<{ host: string }>;
}

const MAX_BODY = 2 * 1024;
const NO_STORE = { "cache-control": "no-store" };

/**
 * What the visitor tapped in an answer (ADR-074): POST /asistente/accion on the portal's host,
 * with the answer's reference and the portal path the link leads to. The server classifies
 * it; whether it counts (this visitor's recent answer, once) is the database's call. Always
 * 204, and nothing of where the visitor goes next is followed.
 */
export async function POST(request: Request, { params }: ActionContext) {
  const view = await portalViewWith((await params).host, "assistant");
  if (view === null) return new Response(null, { status: 404, headers: NO_STORE });
  if (!fromSamePortal(request)) return new Response(null, { status: 403, headers: NO_STORE });
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return new Response(null, { status: 415, headers: NO_STORE });
  }
  const text = await request.text();
  if (text.length > MAX_BODY) return new Response(null, { status: 413, headers: NO_STORE });
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const action = parseAssistantAction(body);
  if (action === null) return new Response(null, { status: 400, headers: NO_STORE });
  const tenantId = view.context.tenant.tenantId;
  const visitor = visitorKey(request);
  after(() => recordAssistantAction(tenantId, visitor, action));
  return new Response(null, { status: 204, headers: NO_STORE });
}

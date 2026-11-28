import { after } from "next/server";

import { parsePersonRequest } from "@rikuy/core";

import { recordAssistantAction, recordPersonRequest } from "@/server/ai-gateway";
import { fromSamePortal, visitorKey } from "@/server/portal-request";
import { portalViewWith } from "@/server/portal-view";

interface PersonContext {
  readonly params: Promise<{ host: string }>;
}

const MAX_BODY = 8 * 1024;
const NO_STORE = { "cache-control": "no-store" };

/**
 * «Pidió una persona» (ADR-073): POST /asistente/persona on the portal's host, when the
 * visitor taps WhatsApp, «Llamar» or the email under an answer. The municipality comes from
 * the host; the request must come from a page of this same portal. Always 204: whether the
 * question was kept (masked, only for this visitor's recent answer) is the database's call.
 */
export async function POST(request: Request, { params }: PersonContext) {
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
  const question = parsePersonRequest(body);
  if (question === null) return new Response(null, { status: 400, headers: NO_STORE });
  const tenantId = view.context.tenant.tenantId;
  const visitor = visitorKey(request);
  after(async () => {
    await recordPersonRequest(tenantId, visitor, question);
    // Also what the visitor did after that answer (ADR-074).
    await recordAssistantAction(tenantId, visitor, {
      requestId: question.requestId,
      action: "person",
      key: null,
    });
  });
  return new Response(null, { status: 204, headers: NO_STORE });
}
